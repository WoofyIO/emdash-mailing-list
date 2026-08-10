/**
 * Runtime entry for the emdash-mailing-list plugin.
 *
 * Data model (plugin storage, scoped to this plugin):
 * - subscribers — id = lowercased email. { email, status, token, softFails,
 *   createdAt, confirmedAt?, unsubscribedAt?, bounceReason? }
 *   status: pending | confirmed | unsubscribed | bounced
 * - blasts — { subject, body, status, total, sent, delivered, failed,
 *   bounced, createdAt, completedAt? }   status: sending | sent
 * - sends — id = `${blastId}:${email}`. { blastId, email, status, error?,
 *   createdAt, sentAt? }   status: queued | sent | delivered | failed | bounced
 *
 * KV:
 * - settings:listName   — human name used in emails ("the Chateau Woofy list")
 * - settings:batchSize  — sends per cron tick (default 25)
 * - settings:redirect   — path to redirect to after confirm/unsubscribe ("/")
 * - state:origin        — site origin, captured from incoming requests
 * - state:webhookSecret — random secret for the Postal webhook URL
 */
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

// ————————————————————————————————— helpers —————————————————————————————————

/** Route handler context: PluginContext plus the request-scoped fields. */
type RC = PluginContext & { input: unknown; request: Request };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Subscriber {
	email: string;
	status: "pending" | "confirmed" | "unsubscribed" | "bounced";
	token: string;
	softFails: number;
	createdAt: string;
	confirmedAt?: string;
	unsubscribedAt?: string;
	bounceReason?: string;
}

interface Blast {
	subject: string;
	body: string;
	status: "sending" | "sent";
	total: number;
	sent: number;
	delivered: number;
	failed: number;
	bounced: number;
	createdAt: string;
	completedAt?: string;
}

interface Send {
	blastId: string;
	email: string;
	status: "queued" | "sent" | "delivered" | "failed" | "bounced";
	error?: string;
	createdAt: string;
	sentAt?: string;
}

function now(): string {
	return new Date().toISOString();
}

function randomToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	return EMAIL_RE.test(email) ? email : null;
}

async function rememberOrigin(ctx: PluginContext, request: Request): Promise<void> {
	try {
		const origin = new URL(request.url).origin;
		const known = await ctx.kv.get<string>("state:origin");
		if (known !== origin) await ctx.kv.set("state:origin", origin);
	} catch {
		/* non-fatal */
	}
}

async function getOrigin(ctx: PluginContext): Promise<string> {
	return (await ctx.kv.get<string>("state:origin")) ?? "";
}

function routeUrl(origin: string, route: string, params: Record<string, string>): string {
	const qs = new URLSearchParams(params).toString();
	return `${origin}/_emdash/api/plugins/emdash-mailing-list/${route}?${qs}`;
}

async function ensureCron(ctx: PluginContext): Promise<void> {
	// Trusted plugins registered in astro.config never fire plugin:activate,
	// so make queue scheduling lazy and idempotent.
	try {
		const existing = await ctx.cron?.list();
		if (!existing?.some((t: { name?: string; taskName?: string }) => (t.name ?? t.taskName) === "process-queue")) {
			await ctx.cron?.schedule("process-queue", { schedule: "* * * * *" });
			ctx.log.info("Mailing list send queue scheduled");
		}
	} catch (error) {
		ctx.log.error("Failed to schedule send queue", error);
	}
}

async function getWebhookSecret(ctx: PluginContext): Promise<string> {
	let secret = await ctx.kv.get<string>("state:webhookSecret");
	if (!secret) {
		secret = randomToken();
		await ctx.kv.set("state:webhookSecret", secret);
	}
	return secret;
}

async function getListName(ctx: PluginContext): Promise<string> {
	return (await ctx.kv.get<string>("settings:listName")) ?? "our mailing list";
}

async function pagePath(ctx: PluginContext, kind: "confirm" | "unsubscribe"): Promise<string> {
	const key = kind === "confirm" ? "settings:confirmPath" : "settings:unsubscribePath";
	return (await ctx.kv.get<string>(key)) ?? `/mailing/${kind}`;
}

function subscribers(ctx: PluginContext) {
	return ctx.storage.subscribers! as unknown as {
		get(id: string): Promise<Subscriber | null>;
		put(id: string, data: Subscriber): Promise<void>;
		delete(id: string): Promise<boolean>;
		putMany(items: Array<{ id: string; data: Subscriber }>): Promise<void>;
		query(o?: object): Promise<{ items: Array<{ id: string; data: Subscriber }>; cursor?: string; hasMore: boolean }>;
		count(where?: object): Promise<number>;
	};
}

function blasts(ctx: PluginContext) {
	return ctx.storage.blasts! as unknown as {
		get(id: string): Promise<Blast | null>;
		put(id: string, data: Blast): Promise<void>;
		query(o?: object): Promise<{ items: Array<{ id: string; data: Blast }>; cursor?: string; hasMore: boolean }>;
	};
}

function sendsStore(ctx: PluginContext) {
	return ctx.storage.sends! as unknown as {
		get(id: string): Promise<Send | null>;
		put(id: string, data: Send): Promise<void>;
		putMany(items: Array<{ id: string; data: Send }>): Promise<void>;
		query(o?: object): Promise<{ items: Array<{ id: string; data: Send }>; cursor?: string; hasMore: boolean }>;
		count(where?: object): Promise<number>;
	};
}

// ————————————————————————————— email composition ————————————————————————————

function withFooter(body: string, listName: string, unsubscribeUrl: string): { text: string; html: string } {
	const text = `${body}\n\n—\nYou're receiving this because you subscribed to ${listName}.\nUnsubscribe: ${unsubscribeUrl}`;
	const paragraphs = body
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("\n");
	const html = `${paragraphs}\n<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">\n<p style="font-size:12px;color:#777">You're receiving this because you subscribed to ${escapeHtml(listName)}. <a href="${unsubscribeUrl}">Unsubscribe</a></p>`;
	return { text, html };
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

async function sendConfirmationEmail(ctx: PluginContext, sub: Subscriber): Promise<void> {
	if (!ctx.email) throw new Error("No email provider is configured");
	const origin = await getOrigin(ctx);
	const listName = await getListName(ctx);
	const confirmUrl = `${origin}${await pagePath(ctx, "confirm")}?token=${sub.token}`;
	await ctx.email.send({
		to: sub.email,
		subject: `Confirm your subscription to ${listName}`,
		text: `Hi!\n\nSomeone (hopefully you) asked to join ${listName}.\n\nConfirm your subscription:\n${confirmUrl}\n\nIf this wasn't you, ignore this email and you won't hear from us again.`,
		html: `<p>Hi!</p><p>Someone (hopefully you) asked to join ${escapeHtml(listName)}.</p><p><a href="${confirmUrl}">Confirm your subscription</a></p><p style="font-size:12px;color:#777">If this wasn't you, ignore this email and you won't hear from us again.</p>`,
	});
}

// ————————————————————————————— blast processing ————————————————————————————

async function processQueue(ctx: PluginContext): Promise<void> {
	const batchSize = (await ctx.kv.get<number>("settings:batchSize")) ?? 25;
	const queued = await sendsStore(ctx).query({
		where: { status: "queued" },
		limit: Math.max(1, Math.min(batchSize, 100)),
	});
	if (queued.items.length === 0) return;
	if (!ctx.email) {
		ctx.log.error("Mailing list: queued sends but no email provider configured");
		return;
	}

	const origin = await getOrigin(ctx);
	const listName = await getListName(ctx);
	const unsubPath = await pagePath(ctx, "unsubscribe");
	const blastCache = new Map<string, Blast>();
	const touchedBlasts = new Set<string>();

	for (const { id, data: send } of queued.items) {
		let blast = blastCache.get(send.blastId) ?? (await blasts(ctx).get(send.blastId));
		if (!blast) {
			await sendsStore(ctx).put(id, { ...send, status: "failed", error: "blast missing" });
			continue;
		}
		blastCache.set(send.blastId, blast);
		touchedBlasts.add(send.blastId);

		const sub = await subscribers(ctx).get(send.email);
		if (!sub || sub.status !== "confirmed") {
			await sendsStore(ctx).put(id, { ...send, status: "failed", error: "not subscribed" });
			blast.failed += 1;
			continue;
		}

		const unsubscribeUrl = `${origin}${unsubPath}?token=${sub.token}`;
		const { text, html } = withFooter(blast.body, listName, unsubscribeUrl);
		try {
			await ctx.email.send({ to: send.email, subject: blast.subject, text, html });
			await sendsStore(ctx).put(id, { ...send, status: "sent", sentAt: now() });
			blast.sent += 1;
		} catch (error) {
			await sendsStore(ctx).put(id, {
				...send,
				status: "failed",
				error: error instanceof Error ? error.message.slice(0, 300) : String(error),
			});
			blast.failed += 1;
		}
	}

	for (const blastId of touchedBlasts) {
		const blast = blastCache.get(blastId)!;
		const remaining = await sendsStore(ctx).count({ blastId, status: "queued" });
		if (remaining === 0 && blast.status === "sending") {
			blast.status = "sent";
			blast.completedAt = now();
		}
		await blasts(ctx).put(blastId, blast);
	}
}

async function enqueueBlast(ctx: PluginContext, subject: string, body: string): Promise<{ blastId: string; total: number }> {
	const blastId = `blast_${Date.now()}_${randomToken().slice(0, 6)}`;
	let total = 0;
	let cursor: string | undefined;
	do {
		const page = await subscribers(ctx).query({
			where: { status: "confirmed" },
			limit: 100,
			cursor,
		});
		if (page.items.length > 0) {
			await sendsStore(ctx).putMany(
				page.items.map(({ data: sub }) => ({
					id: `${blastId}:${sub.email}`,
					data: {
						blastId,
						email: sub.email,
						status: "queued" as const,
						createdAt: now(),
					},
				})),
			);
			total += page.items.length;
		}
		cursor = page.cursor && page.hasMore ? page.cursor : undefined;
	} while (cursor);

	await blasts(ctx).put(blastId, {
		subject,
		body,
		status: "sending",
		total,
		sent: 0,
		delivered: 0,
		failed: 0,
		bounced: 0,
		createdAt: now(),
	});
	return { blastId, total };
}

// —————————————————————————————— webhook events ——————————————————————————————

/**
 * Postal webhook payloads (Server → Webhooks). Relevant events:
 * - MessageSent            — accepted by the remote server (treat as delivered)
 * - MessageDeliveryFailed  — payload.status HardFail/SoftFail
 * - MessageBounced         — a bounce message was received
 * - MessageHeld            — held by Postal (treat as soft failure)
 */
async function handlePostalEvent(ctx: PluginContext, event: string, payload: Record<string, unknown>): Promise<string> {
	const message = (payload?.message ?? payload?.original_message ?? payload) as Record<string, unknown> | undefined;
	const email = normalizeEmail(message?.to);
	if (!email) return "ignored: no recipient";

	const sub = await subscribers(ctx).get(email);
	// Most recent send for this address (single-field index; sort client-side).
	const sendsForEmail = await sendsStore(ctx).query({ where: { email }, limit: 100 });
	const sendRow = sendsForEmail.items
		.slice()
		.sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : -1))[0];

	const applySendStatus = async (status: Send["status"], error?: string) => {
		if (!sendRow || sendRow.data.status === status) return;
		const prev = sendRow.data.status;
		await sendsStore(ctx).put(sendRow.id, { ...sendRow.data, status, error });
		const blast = await blasts(ctx).get(sendRow.data.blastId);
		if (blast) {
			if (status === "delivered" && prev === "sent") blast.delivered += 1;
			if (status === "bounced") blast.bounced += 1;
			await blasts(ctx).put(sendRow.data.blastId, blast);
		}
	};

	switch (event) {
		case "MessageSent":
			await applySendStatus("delivered");
			return `delivered: ${email}`;

		case "MessageBounced": {
			await applySendStatus("bounced", "bounced");
			if (sub && sub.status !== "unsubscribed") {
				await subscribers(ctx).put(email, {
					...sub,
					status: "bounced",
					bounceReason: "bounce received",
					unsubscribedAt: now(),
				});
			}
			return `bounced (removed from list): ${email}`;
		}

		case "MessageDeliveryFailed":
		case "MessageHeld": {
			const status = String((payload as Record<string, unknown>)?.status ?? "");
			const hard = status === "HardFail";
			if (hard) {
				await applySendStatus("bounced", "hard delivery failure");
				if (sub && sub.status !== "unsubscribed") {
					await subscribers(ctx).put(email, {
						...sub,
						status: "bounced",
						bounceReason: `HardFail: ${String((payload as Record<string, unknown>)?.details ?? "").slice(0, 200)}`,
						unsubscribedAt: now(),
					});
				}
				return `hard fail (removed from list): ${email}`;
			}
			// Soft failure — count it; three strikes and the address is out.
			if (sub) {
				const softFails = (sub.softFails ?? 0) + 1;
				if (softFails >= 3 && sub.status === "confirmed") {
					await applySendStatus("bounced", "3 soft failures");
					await subscribers(ctx).put(email, {
						...sub,
						softFails,
						status: "bounced",
						bounceReason: "3 consecutive soft delivery failures",
						unsubscribedAt: now(),
					});
					return `soft fail #${softFails} (removed from list): ${email}`;
				}
				await subscribers(ctx).put(email, { ...sub, softFails });
				return `soft fail #${softFails}: ${email}`;
			}
			return `soft fail (unknown subscriber): ${email}`;
		}

		default:
			return `ignored: ${event}`;
	}
}

// ——————————————————————————————— admin page ————————————————————————————————

async function buildAdminPage(ctx: PluginContext): Promise<Record<string, unknown>> {
	const [confirmed, pending, unsubscribed, bounced] = await Promise.all([
		subscribers(ctx).count({ status: "confirmed" }),
		subscribers(ctx).count({ status: "pending" }),
		subscribers(ctx).count({ status: "unsubscribed" }),
		subscribers(ctx).count({ status: "bounced" }),
	]);

	const recentSubs = await subscribers(ctx).query({
		orderBy: { createdAt: "desc" },
		limit: 15,
	});
	const recentBlasts = await blasts(ctx).query({
		orderBy: { createdAt: "desc" },
		limit: 10,
	});

	const origin = await getOrigin(ctx);
	const secret = await getWebhookSecret(ctx);
	const listName = await getListName(ctx);
	const batchSize = (await ctx.kv.get<number>("settings:batchSize")) ?? 25;
	const webhookUrl = routeUrl(origin || "https://<your-site>", "webhook", { key: secret });
	const subscribeUrl = `${origin || "https://<your-site>"}/_emdash/api/plugins/emdash-mailing-list/subscribe`;

	return {
		blocks: [
			{ type: "header", text: "Mailing List" },
			{
				type: "stats",
				items: [
					{ label: "Confirmed", value: confirmed },
					{ label: "Pending", value: pending },
					{ label: "Unsubscribed", value: unsubscribed },
					{ label: "Bounced", value: bounced },
				],
			},

			{ type: "header", text: "Send a blast" },
			{
				type: "section",
				text: `Composes and queues an email to every confirmed subscriber (currently ${confirmed}). Sending happens in batches of ${batchSize} per minute; progress shows in the table below. An unsubscribe link is added automatically.`,
			},
			{
				type: "form",
				block_id: "compose",
				fields: [
					{ type: "text_input", action_id: "subject", label: "Subject" },
					{
						type: "text_input",
						action_id: "body",
						label: "Message (plain text; blank line = new paragraph)",
						multiline: true,
					},
					{
						type: "text_input",
						action_id: "test_to",
						label: "Send a test to this address instead (leave empty to send the real blast)",
						placeholder: "you@example.com",
					},
				],
				submit: { label: "Send", action_id: "send_blast" },
			},

			{ type: "header", text: "Blasts" },
			{
				type: "table",
				page_action_id: "blasts_page",
				empty_text: "No blasts sent yet.",
				columns: [
					{ key: "subject", label: "Subject" },
					{ key: "status", label: "Status" },
					{ key: "progress", label: "Sent" },
					{ key: "delivered", label: "Delivered" },
					{ key: "failed", label: "Failed" },
					{ key: "bounced", label: "Bounced" },
					{ key: "createdAt", label: "Created", format: "relative_time" },
				],
				rows: recentBlasts.items.map(({ data: b }) => ({
					subject: b.subject,
					status: b.status,
					progress: `${b.sent}/${b.total}`,
					delivered: String(b.delivered),
					failed: String(b.failed),
					bounced: String(b.bounced),
					createdAt: b.createdAt,
				})),
			},

			{ type: "header", text: "Subscribers (latest 15)" },
			{
				type: "table",
				page_action_id: "subs_page",
				empty_text: "No subscribers yet.",
				columns: [
					{ key: "email", label: "Email" },
					{ key: "status", label: "Status" },
					{ key: "createdAt", label: "Signed up", format: "relative_time" },
				],
				rows: recentSubs.items.map(({ data: s }) => ({
					email: s.email,
					status: s.status,
					createdAt: s.createdAt,
				})),
			},
			{
				type: "form",
				block_id: "manual",
				fields: [
					{ type: "text_input", action_id: "email", label: "Email address" },
					{
						type: "select",
						action_id: "action",
						label: "Action",
						options: [
							{ label: "Add as confirmed subscriber", value: "add" },
							{ label: "Unsubscribe / remove", value: "remove" },
						],
					},
				],
				submit: { label: "Apply", action_id: "manual_change" },
			},

			{ type: "header", text: "Settings" },
			{
				type: "form",
				block_id: "settings",
				fields: [
					{
						type: "text_input",
						action_id: "listName",
						label: "List name (used in emails: “you subscribed to …”)",
						initial_value: listName,
					},
					{
						type: "number_input",
						action_id: "batchSize",
						label: "Sends per minute",
						min: 1,
						max: 100,
						initial_value: batchSize,
					},
				],
				submit: { label: "Save Settings", action_id: "save_settings" },
			},

			{ type: "header", text: "Wiring" },
			{
				type: "section",
				text: "Signup endpoint — POST JSON `{ \"email\": \"...\" }` from your site's form. Confirmation and unsubscribe emails link to /mailing/confirm and /mailing/unsubscribe pages on your site (see the README for copy-paste Astro pages; paths configurable via KV settings:confirmPath / settings:unsubscribePath).",
			},
			{ type: "code", code: subscribeUrl, language: "bash" },
			{
				type: "section",
				text: "Bounce tracking — in Postal (Server → Webhooks) add a webhook pointing at the URL below with events MessageSent, MessageDeliveryFailed, MessageBounced, MessageHeld. Hard bounces automatically remove the address from the list; three soft failures do the same.",
			},
			{ type: "code", code: webhookUrl, language: "bash" },
		],
	};
}

// ————————————————————————————————— plugin ——————————————————————————————————

export default definePlugin({
	id: "emdash-mailing-list",
	version: "0.1.0",
	storage: {
		subscribers: { indexes: ["email", "status", "token", "createdAt"] },
		blasts: { indexes: ["status", "createdAt"] },
		sends: { indexes: ["blastId", "email", "status", "createdAt"] },
	},
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				await getWebhookSecret(ctx);
				await ctx.cron!.schedule("process-queue", { schedule: "* * * * *" });
				ctx.log.info("Mailing list plugin activated; send queue scheduled");
			},
		},
		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "process-queue") await processQueue(ctx);
			},
		},
	},

	routes: {
		// POST { email } — public signup. Sends a double opt-in confirmation.
		subscribe: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				// Runtime passes (routeCtx, pluginCtx); newer typings merge them.
				const ctx = (hostCtx ?? rctx) as PluginContext;
				const routeCtx = rctx;
				await rememberOrigin(ctx, routeCtx.request);
				await ensureCron(ctx);
				const input = (routeCtx.input ?? {}) as Record<string, unknown>;
				// Honeypot: real forms leave "website" empty. Bots that fill it get
				// a fake success and no email.
				if (typeof input.website === "string" && input.website.trim() !== "") {
					return { ok: true };
				}
				const email = normalizeEmail(input.email);
				if (!email) return { ok: false, error: "invalid_email" };

				const existing = await subscribers(ctx).get(email);
				if (existing?.status === "confirmed") return { ok: true, already: true };

				const sub: Subscriber = {
					email,
					status: "pending",
					token: existing?.token ?? randomToken(),
					softFails: 0,
					createdAt: existing?.createdAt ?? now(),
				};
				await subscribers(ctx).put(email, sub);
				await sendConfirmationEmail(ctx, sub);
				return { ok: true };
			},
		},

		// GET ?token — confirm subscription, then redirect to the site.
		confirm: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				// Runtime passes (routeCtx, pluginCtx); newer typings merge them.
				const ctx = (hostCtx ?? rctx) as PluginContext;
				const routeCtx = rctx;
				await rememberOrigin(ctx, routeCtx.request);
				const token =
					String((routeCtx.input as Record<string, unknown>)?.token ?? "") ||
					(new URL(routeCtx.request.url).searchParams.get("token") ?? "");
				if (!token) return { ok: false, state: "invalid" };
				const match = await subscribers(ctx).query({ where: { token }, limit: 1 });
				const row = match.items[0];
				if (!row) return { ok: false, state: "invalid" };
				await subscribers(ctx).put(row.id, {
					...row.data,
					status: "confirmed",
					softFails: 0,
					confirmedAt: now(),
				});
				return { ok: true, state: "confirmed" };
			},
		},

		// GET ?token — one-click unsubscribe, then redirect to the site.
		unsubscribe: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				// Runtime passes (routeCtx, pluginCtx); newer typings merge them.
				const ctx = (hostCtx ?? rctx) as PluginContext;
				const routeCtx = rctx;
				await rememberOrigin(ctx, routeCtx.request);
				const token =
					String((routeCtx.input as Record<string, unknown>)?.token ?? "") ||
					(new URL(routeCtx.request.url).searchParams.get("token") ?? "");
				if (!token) return { ok: false, state: "invalid" };
				const match = await subscribers(ctx).query({ where: { token }, limit: 1 });
				const row = match.items[0];
				if (row && row.data.status !== "unsubscribed") {
					await subscribers(ctx).put(row.id, {
						...row.data,
						status: "unsubscribed",
						unsubscribedAt: now(),
					});
				}
				return { ok: true, state: "unsubscribed" };
			},
		},

		// POST — Postal webhook receiver (?key=<secret> authenticates).
		webhook: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				// Runtime passes (routeCtx, pluginCtx); newer typings merge them.
				const ctx = (hostCtx ?? rctx) as PluginContext;
				const routeCtx = rctx;
				const url = new URL(routeCtx.request.url);
				const key = url.searchParams.get("key") ?? "";
				const secret = await ctx.kv.get<string>("state:webhookSecret");
				if (!secret || key !== secret) {
					return { ok: false, error: "unauthorized" };
				}
				const body = (routeCtx.input ?? {}) as Record<string, unknown>;
				const event = String(body.event ?? "");
				const payload = (body.payload ?? {}) as Record<string, unknown>;
				const result = await handlePostalEvent(ctx, event, payload);
				ctx.log.info(`Postal webhook: ${event} → ${result}`);
				return { ok: true, result };
			},
		},

		// Block Kit admin page.
		admin: {
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				// Runtime passes (routeCtx, pluginCtx); newer typings merge them.
				const ctx = (hostCtx ?? rctx) as PluginContext;
				const routeCtx = rctx;
				await rememberOrigin(ctx, routeCtx.request);
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load" || interaction.type === "block_action") {
					await ensureCron(ctx);
					return buildAdminPage(ctx);
				}

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const values = interaction.values ?? {};
					if (typeof values.listName === "string" && values.listName.trim()) {
						await ctx.kv.set("settings:listName", values.listName.trim());
					}
					const batch = Number(values.batchSize);
					if (Number.isFinite(batch) && batch >= 1 && batch <= 100) {
						await ctx.kv.set("settings:batchSize", Math.floor(batch));
					}
					return { ...(await buildAdminPage(ctx)), toast: { message: "Settings saved", type: "success" } };
				}

				if (interaction.type === "form_submit" && interaction.action_id === "manual_change") {
					const values = interaction.values ?? {};
					const email = normalizeEmail(values.email);
					if (!email) {
						return { ...(await buildAdminPage(ctx)), toast: { message: "Invalid email address", type: "error" } };
					}
					const action = String(values.action ?? "add");
					const existing = await subscribers(ctx).get(email);
					if (action === "remove") {
						if (existing) {
							await subscribers(ctx).put(email, {
								...existing,
								status: "unsubscribed",
								unsubscribedAt: now(),
							});
						}
						return { ...(await buildAdminPage(ctx)), toast: { message: `${email} removed`, type: "success" } };
					}
					await subscribers(ctx).put(email, {
						email,
						status: "confirmed",
						token: existing?.token ?? randomToken(),
						softFails: 0,
						createdAt: existing?.createdAt ?? now(),
						confirmedAt: now(),
					});
					return { ...(await buildAdminPage(ctx)), toast: { message: `${email} added as confirmed`, type: "success" } };
				}

				if (interaction.type === "form_submit" && interaction.action_id === "send_blast") {
					const values = interaction.values ?? {};
					const subject = typeof values.subject === "string" ? values.subject.trim() : "";
					const body = typeof values.body === "string" ? values.body.trim() : "";
					const testTo = normalizeEmail(values.test_to);
					if (!subject || !body) {
						return { ...(await buildAdminPage(ctx)), toast: { message: "Subject and message are required", type: "error" } };
					}

					try {
						if (testTo) {
							if (!ctx.email) throw new Error("No email provider is configured");
							const origin = await getOrigin(ctx);
							const listName = await getListName(ctx);
							const { text, html } = withFooter(body, listName, `${origin}${await pagePath(ctx, "unsubscribe")}?token=test`);
							await ctx.email.send({ to: testTo, subject: `[TEST] ${subject}`, text, html });
							return { ...(await buildAdminPage(ctx)), toast: { message: `Test sent to ${testTo}`, type: "success" } };
						}
						await ensureCron(ctx);
						const { total } = await enqueueBlast(ctx, subject, body);
						if (total === 0) {
							return { ...(await buildAdminPage(ctx)), toast: { message: "No confirmed subscribers to send to", type: "error" } };
						}
						return {
							...(await buildAdminPage(ctx)),
							toast: { message: `Blast queued to ${total} subscribers — sending starts within a minute`, type: "success" },
						};
					} catch (error) {
						return {
							...(await buildAdminPage(ctx)),
							toast: { message: `Error: ${error instanceof Error ? error.message : String(error)}`, type: "error" },
						};
					}
				}

				return { blocks: [] };
			},
		},
	},
});
