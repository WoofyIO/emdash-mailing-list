/**
 * Route handlers. Public routes are the site-facing API (signup, confirm,
 * unsubscribe, contact, Postal webhook, health); everything else backs the
 * admin pages and requires an admin session.
 *
 * Handlers are typed against their zod input; the routes record erases that
 * generic, so index.ts casts each one at the boundary.
 */
import type { PluginContext, RouteContext } from "emdash";
import { PluginRouteError } from "emdash";
import { z } from "zod";

import { handlePostalEvent } from "./engine/postal-events.js";
import {
	blasts,
	enqueueBlast,
	ensureCron,
	outbox,
	sendTest,
	sendsStore,
	summarize,
	unsubscribeHeaders,
} from "./engine/queue.js";
import {
	escapeHtml,
	placeholderSubscriber,
	renderEmail,
	subscriberForPreview,
	type PortableTextBlocks,
} from "./engine/render.js";
import {
	getCollection,
	getListName,
	getOrigin,
	getSettings,
	getWebhookSecret,
	normalizeEmail,
	now,
	pagePath,
	randomToken,
	rememberOrigin,
	saveSettings,
} from "./engine/settings.js";
import {
	collectionAvailable,
	countSubscribers,
	deleteSubscriber,
	findByEmail,
	findByToken,
	listAllSubscribers,
	migrateLegacySubscribers,
	upsertSubscriber,
	type SubscriberData,
} from "./engine/subscribers.js";
import { compileSelection, describeSources, resolveRecipients, sampleSubscribers } from "./engine/targeting.js";

// ─── schemas ──────────────────────────────────────────────────────────────────

const ptBlocks = z.array(z.record(z.string(), z.unknown()));

export const contentInput = z.object({
	subject: z.string().max(300),
	body: z.string().max(100_000).optional(),
	bodyPT: ptBlocks.optional(),
});

export const targetsInput = z.object({
	includePrimary: z.boolean().default(true),
	sources: z.record(z.string(), z.object({ include: z.boolean(), values: z.array(z.string()).optional() })).default({}),
	advanced: z.string().max(5_000).optional(),
});

export const previewInput = contentInput.extend({ sampleEmail: z.string().optional() });
export const evaluateInput = z.object({ targets: targetsInput });
export const sendInput = contentInput.extend({ targets: targetsInput });
export const sendTestInput = contentInput.extend({ to: z.string() });
export const subscriberListInput = z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).optional() });
export const subscriberActionInput = z.object({
	email: z.string(),
	action: z.enum(["confirm", "block", "unblock", "delete", "add"]),
});
export const blastInput = z.object({ id: z.string() });
export const settingsInput = z.object({
	listName: z.string().max(200).optional(),
	batchSize: z.number().optional(),
	contactTo: z.string().max(200).optional(),
	collections: z.string().max(1000).optional(),
	groupFields: z.string().max(1000).optional(),
	template: z.string().max(200_000).optional(),
	confirmPath: z.string().max(200).optional(),
	unsubscribePath: z.string().max(200).optional(),
});

type Content = z.infer<typeof contentInput>;

function requireContent(input: Content): { subject: string; body?: string; bodyPT?: PortableTextBlocks } {
	const subject = input.subject.trim();
	const hasPT = Array.isArray(input.bodyPT) && input.bodyPT.length > 0;
	const body = (input.body ?? "").trim();
	if (!subject) throw PluginRouteError.badRequest("Subject is required");
	if (!hasPT && !body) throw PluginRouteError.badRequest("The message is empty");
	return { subject, body: body || undefined, bodyPT: hasPT ? (input.bodyPT as PortableTextBlocks) : undefined };
}

// ─── public: signup / confirm / unsubscribe ──────────────────────────────────

export async function subscribe(ctx: RouteContext<Record<string, unknown>>) {
	await rememberOrigin(ctx, ctx.request);
	await ensureCron(ctx);
	const input = ctx.input ?? {};
	if (typeof input.website === "string" && input.website.trim() !== "") return { ok: true }; // honeypot
	const email = normalizeEmail(input.email);
	if (!email) return { ok: false, error: "invalid_email" };
	if (!(await collectionAvailable(ctx))) return { ok: false, error: "not_configured" };

	const existing = await findByEmail(ctx, email);
	if (existing?.data.subscription === "confirmed" && !existing.data.blocked) return { ok: true, already: true };
	const entry = await upsertSubscriber(ctx, email, {
		subscription: "pending",
		source: (existing?.data.source as string) ?? "signup",
		token: existing?.data.token ?? randomToken(),
	});
	await sendConfirmationEmail(ctx, entry.data);
	return { ok: true };
}

async function sendConfirmationEmail(ctx: PluginContext, sub: SubscriberData): Promise<void> {
	if (!ctx.email) throw new Error("No email provider is configured");
	const origin = await getOrigin(ctx);
	const listName = await getListName(ctx);
	const confirmUrl = `${origin}${await pagePath(ctx, "confirm")}?token=${sub.token}`;
	const body = `Hi!\n\nSomeone (hopefully you) asked to join ${listName}.\n\n[Confirm your subscription](${confirmUrl})\n\nIf this wasn't you, ignore this email and you won't hear from us again.`;
	const rendered = await renderEmail(ctx, { subject: `Confirm your subscription to ${listName}`, body }, sub);
	await ctx.email.send({
		to: sub.email,
		subject: rendered.subject,
		text: `Hi!\n\nSomeone (hopefully you) asked to join ${listName}.\n\nConfirm your subscription:\n${confirmUrl}\n\nIf this wasn't you, ignore this email and you won't hear from us again.`,
		html: rendered.html,
	});
}

function tokenFrom(ctx: RouteContext<Record<string, unknown>>): string {
	const fromBody = ctx.input && typeof ctx.input.token === "string" ? ctx.input.token : "";
	return fromBody || new URL(ctx.request.url).searchParams.get("token") || "";
}

export async function confirm(ctx: RouteContext<Record<string, unknown>>) {
	await rememberOrigin(ctx, ctx.request);
	const entry = await findByToken(ctx, tokenFrom(ctx));
	if (!entry) return { ok: false, state: "invalid" };
	await upsertSubscriber(ctx, entry.data.email, { subscription: "confirmed", soft_fails: 0 });
	return { ok: true, state: "confirmed" };
}

export async function unsubscribe(ctx: RouteContext<Record<string, unknown>>) {
	await rememberOrigin(ctx, ctx.request);
	const entry = await findByToken(ctx, tokenFrom(ctx));
	if (entry && entry.data.subscription !== "unsubscribed") {
		await upsertSubscriber(ctx, entry.data.email, { subscription: "unsubscribed" });
	}
	return { ok: entry != null, state: entry ? "unsubscribed" : "invalid" };
}

// ─── public: contact form ────────────────────────────────────────────────────

/**
 * POST { name, email, subject?, message } — both the operator copy and the
 * acknowledgement are queued, never sent here. The acknowledgement carries no
 * content from the submission: all of it is attacker-controlled and goes to an
 * address nobody has verified.
 */
export async function contact(ctx: RouteContext<Record<string, unknown>>) {
	await rememberOrigin(ctx, ctx.request);
	const input = ctx.input ?? {};
	if (typeof input.website === "string" && input.website.trim() !== "") return { ok: true }; // honeypot
	const email = normalizeEmail(input.email);
	const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
	const subject = typeof input.subject === "string" ? input.subject.trim().slice(0, 200) : "";
	const message = typeof input.message === "string" ? input.message.trim().slice(0, 5000) : "";
	if (!email) return { ok: false, error: "invalid_email" };
	if (!name || !message) return { ok: false, error: "missing_fields" };
	const contactTo = (await ctx.kv.get<string>("settings:contactTo")) ?? "";
	if (!contactTo) return { ok: false, error: "not_configured" };
	if (!ctx.email) return { ok: false, error: "no_email_provider" };

	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await outbox(ctx).put(`contact-${stamp}`, {
		to: contactTo,
		subject: `[Contact] ${subject || "New message"} — ${name}`,
		text: `New contact form message\n\nFrom: ${name} <${email}>\nSubject: ${subject || "(none)"}\n\n${message}\n\n—\nSent from the website contact form. Replying goes to the sender.`,
		html: `<p><strong>New contact form message</strong></p>
<p>From: ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;<br>Subject: ${escapeHtml(subject || "(none)")}</p>
<blockquote style="border-left:3px solid #ccc;margin:12px 0;padding:4px 12px;white-space:pre-wrap">${escapeHtml(message)}</blockquote>
<p style="font-size:12px;color:#777">Sent from the website contact form. Replying goes to the sender.</p>`,
		replyTo: email,
		createdAt: now(),
		attempts: 0,
	});
	await outbox(ctx).put(`ack-${stamp}`, {
		to: email,
		subject: "We got your message",
		text: `Thanks for getting in touch — we've got your message and will reply soon.\n\nThis is an automated confirmation. If you didn't contact us, you can ignore it.`,
		html: `<p>Thanks for getting in touch — we've got your message and will reply soon.</p>
<p style="font-size:12px;color:#777">This is an automated confirmation. If you didn't contact us, you can ignore it.</p>`,
		createdAt: now(),
		attempts: 0,
	});
	await ensureCron(ctx);
	return { ok: true };
}

// ─── public: Postal webhook + health ─────────────────────────────────────────

export async function webhook(ctx: RouteContext<Record<string, unknown>>) {
	const key = new URL(ctx.request.url).searchParams.get("key") ?? "";
	const secret = await ctx.kv.get<string>("state:webhookSecret");
	if (!secret || key !== secret) return { ok: false, error: "unauthorized" };
	const body = ctx.input ?? {};
	const event = String(body.event ?? "");
	const payload = (body.payload ?? {}) as Record<string, unknown>;
	const result = await handlePostalEvent(ctx, event, payload);
	ctx.log.info(`Postal webhook: ${event} → ${result}`);
	return { ok: true, result };
}

/** Keyword-monitor on "healthy": only when every check passes. */
export async function health(ctx: RouteContext) {
	const checks: Record<string, unknown> = {};
	const database = await collectionAvailable(ctx);
	checks.database = database ? "up" : "down";
	const emailProvider = Boolean(ctx.email);
	checks.email_provider = emailProvider ? "configured" : "missing";
	const lastCron = await ctx.kv.get<string>("state:lastCron");
	const cronAge = lastCron ? Math.round((Date.now() - new Date(lastCron).getTime()) / 1000) : null;
	checks.cron_age_seconds = cronAge;
	const cronOk = cronAge !== null && cronAge < 300;
	checks.cron = cronOk ? "beating" : "stale";
	let queueOk = true;
	try {
		const queued = await sendsStore(ctx).count({ status: "queued" });
		checks.queued_sends = queued;
		queueOk = queued === 0 || cronOk;
	} catch {
		queueOk = false;
		checks.queued_sends = "unknown";
	}
	const healthy = database && emailProvider && cronOk && queueOk;
	return { status: healthy ? "healthy" : "degraded", checks, ts: now() };
}

// ─── admin: overview ─────────────────────────────────────────────────────────

export async function overview(ctx: RouteContext) {
	await rememberOrigin(ctx, ctx.request);
	await ensureCron(ctx);
	await migrateLegacySubscribers(ctx);
	const available = await collectionAvailable(ctx);
	const collection = await getCollection(ctx);
	const all = available ? await listAllSubscribers(ctx) : [];
	const recent = await blasts(ctx).query({ orderBy: { createdAt: "desc" }, limit: 25 });
	const sources = available ? await describeSources(ctx) : [];
	const extraOnly = sources.reduce((n, s) => n + s.total, 0);
	return {
		available,
		collection,
		counts: countSubscribers(all),
		extraSources: sources.map((s) => ({ collection: s.collection, total: s.total })),
		extraTotal: extraOnly,
		blasts: recent.items.map(({ id, data }) => summarize(id, data)),
		health: await health(ctx),
	};
}

// ─── admin: compose ──────────────────────────────────────────────────────────

export async function composeOptions(ctx: RouteContext) {
	await rememberOrigin(ctx, ctx.request);
	return {
		listName: await getListName(ctx),
		primary: await getCollection(ctx),
		sources: await describeSources(ctx),
		sampleEmails: await sampleSubscribers(ctx),
	};
}

export async function preview(ctx: RouteContext<z.infer<typeof previewInput>>) {
	await rememberOrigin(ctx, ctx.request);
	const { subject, body, bodyPT } = {
		subject: ctx.input.subject || "(no subject)",
		body: ctx.input.body,
		bodyPT: ctx.input.bodyPT as PortableTextBlocks | undefined,
	};
	const email = normalizeEmail(ctx.input.sampleEmail);
	const entry = email ? await findByEmail(ctx, email) : null;
	const sample = entry ? await subscriberForPreview(ctx, entry) : placeholderSubscriber();
	const rendered = await renderEmail(ctx, { subject, body, bodyPT }, sample);
	return { ...rendered, sample: { email: sample.email, fields: Object.keys(sample).filter((k) => !k.startsWith("_")) } };
}

export async function evaluate(ctx: RouteContext<z.infer<typeof evaluateInput>>) {
	const filtersRaw = await compileSelection(ctx, ctx.input.targets);
	const recipients = await resolveRecipients(ctx, filtersRaw, ctx.input.targets.includePrimary);
	return {
		filtersRaw,
		total: recipients.length,
		recipients: recipients.slice(0, 500).map((r) => ({ email: r.email, source: r.source, state: r.state })),
	};
}

export async function sendTestRoute(ctx: RouteContext<z.infer<typeof sendTestInput>>) {
	await rememberOrigin(ctx, ctx.request);
	const to = normalizeEmail(ctx.input.to);
	if (!to) throw PluginRouteError.badRequest("Enter a valid test address");
	await sendTest(ctx, requireContent(ctx.input), to);
	return { ok: true, to };
}

export async function send(ctx: RouteContext<z.infer<typeof sendInput>>) {
	await rememberOrigin(ctx, ctx.request);
	const content = requireContent(ctx.input);
	const filtersRaw = await compileSelection(ctx, ctx.input.targets);
	const { blastId, total } = await enqueueBlast(ctx, content, filtersRaw, ctx.input.targets.includePrimary);
	if (total === 0) {
		await blasts(ctx).delete(blastId);
		throw PluginRouteError.badRequest("No sendable recipients match that selection");
	}
	return { ok: true, blastId, total };
}

// ─── admin: blasts ───────────────────────────────────────────────────────────

export async function listBlasts(ctx: RouteContext) {
	const page = await blasts(ctx).query({ orderBy: { createdAt: "desc" }, limit: 100 });
	return { blasts: page.items.map(({ id, data }) => summarize(id, data)) };
}

export async function blastDetail(ctx: RouteContext<z.infer<typeof blastInput>>) {
	const blast = await blasts(ctx).get(ctx.input.id);
	if (!blast) throw PluginRouteError.notFound("No such blast");
	const problems = await sendsStore(ctx).query({ where: { blastId: ctx.input.id }, limit: 500 });
	const failures = problems.items
		.filter((s) => s.data.status === "failed" || s.data.status === "bounced" || s.data.status === "delayed" || s.data.status === "held")
		.map((s) => ({ email: s.data.email, status: s.data.status, error: s.data.error ?? "" }));
	const rendered = await renderEmail(ctx, blast, placeholderSubscriber());
	return { blast: summarize(ctx.input.id, blast), body: blast.body, bodyPT: blast.bodyPT ?? null, failures, html: rendered.html };
}

// ─── admin: subscribers ──────────────────────────────────────────────────────

export async function listSubscribers(ctx: RouteContext<z.infer<typeof subscriberListInput>>) {
	if (!(await collectionAvailable(ctx))) return { available: false, subscribers: [], total: 0 };
	const all = await listAllSubscribers(ctx);
	const q = (ctx.input.query ?? "").trim().toLowerCase();
	const filtered = q
		? all.filter((e) => e.data.email.includes(q) || String(e.data.source ?? "").toLowerCase().includes(q) || String(e.data.subscription).includes(q))
		: all;
	const limit = ctx.input.limit ?? 200;
	return {
		available: true,
		total: filtered.length,
		subscribers: filtered.slice(0, limit).map((e) => ({
			email: e.data.email,
			subscription: e.data.subscription,
			blocked: Boolean(e.data.blocked),
			source: String(e.data.source ?? ""),
			bounceReason: String(e.data.bounce_reason ?? ""),
			softFails: Number(e.data.soft_fails ?? 0),
		})),
	};
}

export async function subscriberAction(ctx: RouteContext<z.infer<typeof subscriberActionInput>>) {
	const email = normalizeEmail(ctx.input.email);
	if (!email) throw PluginRouteError.badRequest("Invalid email address");
	if (ctx.input.action === "add") {
		await upsertSubscriber(ctx, email, { subscription: "confirmed", source: "manual" });
		return { ok: true, message: `${email} added as confirmed` };
	}
	const entry = await findByEmail(ctx, email);
	if (!entry) throw PluginRouteError.notFound(`${email} is not on the list`);
	switch (ctx.input.action) {
		case "confirm":
			await upsertSubscriber(ctx, email, { subscription: "confirmed", soft_fails: 0 });
			return { ok: true, message: `${email} confirmed` };
		case "block":
			await upsertSubscriber(ctx, email, { blocked: true, bounce_reason: "manually blocked" });
			return { ok: true, message: `${email} blocked` };
		case "unblock":
			await upsertSubscriber(ctx, email, { blocked: false, soft_fails: 0, bounce_reason: "" });
			return { ok: true, message: `${email} unblocked` };
		case "delete":
			await deleteSubscriber(ctx, entry);
			return { ok: true, message: `${email} deleted` };
	}
	return { ok: false };
}

// ─── admin: settings ─────────────────────────────────────────────────────────

export async function settingsGet(ctx: RouteContext) {
	await rememberOrigin(ctx, ctx.request);
	const origin = (await getOrigin(ctx)) || "https://<your-site>";
	const secret = await getWebhookSecret(ctx);
	return {
		settings: await getSettings(ctx),
		wiring: {
			subscribeUrl: `${origin}/_emdash/api/plugins/emdash-mailing-list/subscribe`,
			contactUrl: `${origin}/_emdash/api/plugins/emdash-mailing-list/contact`,
			webhookUrl: `${origin}/_emdash/api/plugins/emdash-mailing-list/webhook?key=${secret}`,
			healthUrl: `${origin}/_emdash/api/plugins/emdash-mailing-list/health`,
		},
		defaultsNote: "Leave the template empty to use the plain built-in one.",
	};
}

export async function settingsSave(ctx: RouteContext<z.infer<typeof settingsInput>>) {
	const problem = await saveSettings(ctx, ctx.input);
	if (problem) throw PluginRouteError.badRequest(problem);
	return { ok: true, settings: await getSettings(ctx) };
}

export { unsubscribeHeaders };
