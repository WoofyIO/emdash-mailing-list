/**
 * Runtime entry for the emdash-mailing-list plugin (v0.2).
 *
 * Subscribers are regular CMS content entries in a `subscribers` collection
 * (configurable via KV `settings:collection`), so admins can browse them under
 * Content, extend the schema with custom fields (e.g. `is_wine_club_member`),
 * and use any field as a {{merge_tag}} in blasts. Minimum fields:
 *   email (string), status (string: pending|confirmed|unsubscribed),
 *   blocked (boolean), token (string), soft_fails (integer),
 *   bounce_reason (string)
 *
 * Plugin storage keeps the machinery: blasts + per-recipient sends.
 * KV keeps settings, the site origin, the webhook secret, and a
 * token → entry-slug index (`tok:<token>`).
 *
 * Blast bodies are Markdown; sends render them to HTML inside an admin-editable
 * HTML template (KV `settings:template`, `{{content}}`/`{{subject}}`/
 * `{{unsubscribe_url}}` placeholders) with a plain-text alternative.
 */
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

// ————————————————————————————————— types ———————————————————————————————————

/** Route handler context: PluginContext plus the request-scoped fields. */
type RC = PluginContext & { input: unknown; request: Request };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SubscriberData {
	email: string;
	subscription: "pending" | "confirmed" | "unsubscribed";
	blocked: boolean;
	token: string;
	soft_fails: number;
	bounce_reason?: string;
	[key: string]: unknown; // admin-added custom fields (merge tags)
}

interface SubscriberEntry {
	id: string;
	slug: string | null;
	data: SubscriberData;
}

interface Blast {
	subject: string;
	body: string;
	filters?: string;
	includePrimary?: boolean;
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

// ————————————————————————————————— helpers —————————————————————————————————

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

/** Source collections; first is the primary list where signups/suppression live. */
async function getCollections(ctx: PluginContext): Promise<string[]> {
	const raw =
		(await ctx.kv.get<string>("settings:collections")) ??
		(await ctx.kv.get<string>("settings:collection")) ??
		"subscribers";
	const slugs = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return slugs.length > 0 ? slugs : ["subscribers"];
}

async function getCollection(ctx: PluginContext): Promise<string> {
	return (await getCollections(ctx))[0];
}

/**
 * Collection-scoped recipient filters, one per line:
 *   attendees: year=2026, void=false
 * Comma-separated pairs are ANDed. Values compare as booleans ("true"/"false"),
 * numbers, or case-insensitive strings. A collection with no line is unfiltered.
 */
type RecipientFilters = Map<string, Array<[string, string]>>;

function parseFilters(raw: string): RecipientFilters {
	const filters: RecipientFilters = new Map();
	for (const line of raw.split("\n")) {
		const m = line.match(/^\s*([a-z][a-z0-9_]*)\s*:\s*(.+)$/i);
		if (!m) continue;
		const pairs: Array<[string, string]> = [];
		for (const part of m[2].split(",")) {
			const kv = part.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*(.*?)\s*$/);
			if (kv) pairs.push([kv[1], kv[2]]);
		}
		if (pairs.length) filters.set(m[1].toLowerCase(), pairs);
	}
	return filters;
}

function matchesFilter(data: Record<string, unknown>, pairs: Array<[string, string]> | undefined): boolean {
	if (!pairs) return true;
	return pairs.every(([key, expected]) => {
		const actual = data[key];
		const exp = expected.toLowerCase();
		if (exp === "true" || exp === "false") return Boolean(actual) === (exp === "true");
		if (actual === undefined || actual === null) return exp === "";
		if (typeof actual === "number" && !Number.isNaN(Number(expected))) return actual === Number(expected);
		return String(actual).toLowerCase() === exp;
	});
}

/**
 * Recipient data from EXTRA source collections (e.g. an attendees list):
 * email → entry data (+ _collection), first occurrence wins. These entries
 * only need an `email` field; their other fields become merge tags.
 */
async function gatherExtraData(
	ctx: PluginContext,
	filters?: RecipientFilters,
): Promise<Map<string, Record<string, unknown>>> {
	const [, ...extras] = await getCollections(ctx);
	const map = new Map<string, Record<string, unknown>>();
	const api = contentApi(ctx);
	for (const collection of extras) {
		const pairs = filters?.get(collection.toLowerCase());
		try {
			let cursor: string | undefined;
			do {
				const page = await api.list(collection, { limit: 100, cursor });
				for (const entry of page.items) {
					const email = normalizeEmail(entry.data?.email);
					if (!email || map.has(email)) continue;
					if (!matchesFilter(entry.data as Record<string, unknown>, pairs)) continue;
					map.set(email, { ...(entry.data as Record<string, unknown>), _collection: collection });
				}
				cursor = page.hasMore ? page.cursor : undefined;
			} while (cursor);
		} catch (error) {
			ctx.log.error(`Mailing list: cannot read source collection "${collection}"`, error);
		}
	}
	return map;
}

async function pagePath(ctx: PluginContext, kind: "confirm" | "unsubscribe"): Promise<string> {
	const key = kind === "confirm" ? "settings:confirmPath" : "settings:unsubscribePath";
	return (await ctx.kv.get<string>(key)) ?? `/mailing/${kind}`;
}

async function ensureCron(ctx: PluginContext): Promise<void> {
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

// ———————————————————————— subscriber content store —————————————————————————

function contentApi(ctx: PluginContext) {
	if (!ctx.content) throw new Error("Missing content capability");
	return ctx.content as unknown as {
		get(collection: string, id: string): Promise<SubscriberEntry | null>;
		list(
			collection: string,
			options?: object,
		): Promise<{ items: SubscriberEntry[]; cursor?: string; hasMore: boolean }>;
		create(collection: string, data: object): Promise<SubscriberEntry>;
		update(collection: string, id: string, data: object): Promise<SubscriberEntry>;
		delete(collection: string, id: string): Promise<boolean>;
	};
}

/** Whether the subscribers collection exists (plugin degrades politely if not). */
async function collectionAvailable(ctx: PluginContext): Promise<boolean> {
	try {
		await contentApi(ctx).list(await getCollection(ctx), { limit: 1 });
		return true;
	} catch {
		return false;
	}
}

async function listAllSubscribers(ctx: PluginContext): Promise<SubscriberEntry[]> {
	const collection = await getCollection(ctx);
	const api = contentApi(ctx);
	const all: SubscriberEntry[] = [];
	let cursor: string | undefined;
	do {
		const page = await api.list(collection, { limit: 100, cursor });
		all.push(...page.items.filter((e) => typeof e.data?.email === "string"));
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && all.length < 10_000);
	return all;
}

async function findByEmail(ctx: PluginContext, email: string): Promise<SubscriberEntry | null> {
	const all = await listAllSubscribers(ctx);
	return all.find((e) => e.data.email === email) ?? null;
}

async function findByToken(ctx: PluginContext, token: string): Promise<SubscriberEntry | null> {
	if (!token) return null;
	const collection = await getCollection(ctx);
	const knownId = await ctx.kv.get<string>(`tok:${token}`);
	if (knownId) {
		const entry = await contentApi(ctx).get(collection, knownId).catch(() => null);
		if (entry?.data?.token === token) return entry;
	}
	const all = await listAllSubscribers(ctx);
	const match = all.find((e) => e.data.token === token) ?? null;
	if (match) await ctx.kv.set(`tok:${token}`, match.id);
	return match;
}

/** Title mirrors state so the admin Content list reads at a glance. */
function subscriberTitle(d: Pick<SubscriberData, "email" | "subscription" | "blocked">): string {
	if (d.blocked) return `${d.email} — blocked`;
	if (d.subscription !== "confirmed") return `${d.email} — ${d.subscription}`;
	return d.email;
}

async function upsertSubscriber(
	ctx: PluginContext,
	email: string,
	patch: Partial<SubscriberData>,
): Promise<SubscriberEntry> {
	const collection = await getCollection(ctx);
	const api = contentApi(ctx);
	const existing = await findByEmail(ctx, email);
	if (existing) {
		const merged = { ...existing.data, ...patch };
		// Plugin write input is flat field values; only pass the changed fields.
		return api.update(collection, existing.id, { ...patch, title: subscriberTitle(merged) });
	}
	const token = (patch.token as string) ?? randomToken();
	const data: SubscriberData = {
		email,
		subscription: "pending",
		blocked: false,
		token,
		soft_fails: 0,
		...patch,
	};
	data.title = subscriberTitle(data);
	const entry = await api.create(collection, { ...data });
	await ctx.kv.set(`tok:${token}`, entry.id);
	return entry;
}

/** One-time migration from v0.1 plugin-storage subscribers to the collection. */
async function migrateLegacySubscribers(ctx: PluginContext): Promise<void> {
	const legacy = ctx.storage.subscribers as
		| { query(o?: object): Promise<{ items: Array<{ id: string; data: Record<string, unknown> }> }>; delete(id: string): Promise<boolean> }
		| undefined;
	if (!legacy) return;
	try {
		const rows = await legacy.query({ limit: 100 });
		if (rows.items.length === 0) return;
		if (!(await collectionAvailable(ctx))) return;
		for (const { id, data } of rows.items) {
			const email = normalizeEmail(data.email ?? id);
			if (!email) continue;
			const subscription =
				data.status === "bounced" ? "confirmed" : ((data.status as SubscriberData["subscription"]) ?? "pending");
			await upsertSubscriber(ctx, email, {
				subscription,
				blocked: data.status === "bounced",
				token: (data.token as string) ?? randomToken(),
				soft_fails: (data.softFails as number) ?? 0,
				bounce_reason: (data.bounceReason as string) ?? undefined,
			});
			await legacy.delete(id);
		}
		ctx.log.info(`Migrated ${rows.items.length} legacy subscribers into the collection`);
	} catch (error) {
		ctx.log.error("Legacy subscriber migration failed", error);
	}
}

// ——————————————————————— markdown, templates, merging ———————————————————————

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Tiny Markdown subset: #/##/### headings, -/* lists, ---, **bold**, *italic*, [text](url). */
function markdownToHtml(md: string): string {
	const inline = (s: string): string =>
		escapeHtml(s)
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>");

	return md
		.split(/\n{2,}/)
		.map((block) => {
			const trimmed = block.trim();
			if (!trimmed) return "";
			if (/^---+$/.test(trimmed)) return "<hr>";
			const heading = trimmed.match(/^(#{1,3})\s+(.*)$/s);
			if (heading) {
				const level = heading[1].length + 1; // h2–h4 inside emails
				return `<h${level}>${inline(heading[2].trim())}</h${level}>`;
			}
			const lines = trimmed.split("\n");
			if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
				const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("");
				return `<ul>${items}</ul>`;
			}
			return `<p>${lines.map(inline).join("<br>")}</p>`;
		})
		.filter(Boolean)
		.join("\n");
}

/** Plain-text version: markdown with links flattened and emphasis stripped. */
function markdownToText(md: string): string {
	return md
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/^#{1,3}\s+/gm, "");
}

/** Replace {{field}} merge tags from subscriber data (missing fields → ""). */
function mergeTags(text: string, data: Record<string, unknown>): string {
	return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
		const value = data[key];
		if (value === undefined || value === null) return "";
		return typeof value === "string" ? value : String(value);
	});
}

const DEFAULT_TEMPLATE = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Georgia,serif;color:#222">
	<div style="max-width:600px;margin:0 auto;padding:32px 24px;background:#ffffff">
		{{content}}
		<hr style="border:none;border-top:1px solid #ddd;margin:32px 0 16px">
		<p style="font-size:12px;color:#777">You're receiving this because you subscribed to {{list_name}}.
		<a href="{{unsubscribe_url}}" style="color:#777">Unsubscribe</a></p>
	</div>
</body>
</html>`;

async function renderEmail(
	ctx: PluginContext,
	subject: string,
	body: string,
	subscriber: SubscriberData,
): Promise<{ subject: string; text: string; html: string }> {
	const origin = await getOrigin(ctx);
	const listName = await getListName(ctx);
	const unsubscribeUrl = `${origin}${await pagePath(ctx, "unsubscribe")}?token=${subscriber.token}`;
	const template = (await ctx.kv.get<string>("settings:template")) || DEFAULT_TEMPLATE;

	const mergedSubject = mergeTags(subject, subscriber);
	const mergedBody = mergeTags(body, subscriber);

	const html = template
		.replace(/\{\{\s*content\s*\}\}/g, markdownToHtml(mergedBody))
		.replace(/\{\{\s*subject\s*\}\}/g, escapeHtml(mergedSubject))
		.replace(/\{\{\s*unsubscribe_url\s*\}\}/g, unsubscribeUrl)
		.replace(/\{\{\s*list_name\s*\}\}/g, escapeHtml(listName));

	const text = `${markdownToText(mergedBody)}\n\n—\nYou're receiving this because you subscribed to ${listName}.\nUnsubscribe: ${unsubscribeUrl}`;

	return { subject: mergedSubject, text, html };
}

async function sendConfirmationEmail(ctx: PluginContext, sub: SubscriberData): Promise<void> {
	if (!ctx.email) throw new Error("No email provider is configured");
	const origin = await getOrigin(ctx);
	const listName = await getListName(ctx);
	const confirmUrl = `${origin}${await pagePath(ctx, "confirm")}?token=${sub.token}`;
	const body = `Hi!\n\nSomeone (hopefully you) asked to join ${listName}.\n\n[Confirm your subscription](${confirmUrl})\n\nIf this wasn't you, ignore this email and you won't hear from us again.`;
	const rendered = await renderEmail(ctx, `Confirm your subscription to ${listName}`, body, sub);
	await ctx.email.send({
		to: sub.email,
		subject: rendered.subject,
		text: `Hi!\n\nSomeone (hopefully you) asked to join ${listName}.\n\nConfirm your subscription:\n${confirmUrl}\n\nIf this wasn't you, ignore this email and you won't hear from us again.`,
		html: rendered.html,
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

	const blastCache = new Map<string, Blast>();
	const touchedBlasts = new Set<string>();
	const extras = await gatherExtraData(ctx);

	for (const { id, data: send } of queued.items) {
		const blast = blastCache.get(send.blastId) ?? (await blasts(ctx).get(send.blastId));
		if (!blast) {
			await sendsStore(ctx).put(id, { ...send, status: "failed", error: "blast missing" });
			continue;
		}
		blastCache.set(send.blastId, blast);
		touchedBlasts.add(send.blastId);

		const entry = await findByEmail(ctx, send.email);
		const sub = entry?.data;
		if (!sub || sub.subscription !== "confirmed" || sub.blocked) {
			await sendsStore(ctx).put(id, { ...send, status: "failed", error: "not subscribed or blocked" });
			blast.failed += 1;
			continue;
		}

		try {
			// Extra-source fields (attendee name, ticket type, …) merge under the
			// primary record, so custom fields work as merge tags.
			const mergedSub = { ...(extras.get(send.email) ?? {}), ...sub } as SubscriberData;
			const rendered = await renderEmail(ctx, blast.subject, blast.body, mergedSub);
			await ctx.email.send({ to: send.email, subject: rendered.subject, text: rendered.text, html: rendered.html });
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

interface ResolvedRecipient {
	email: string;
	/** "subscribers" for primary-list members, else the extra collection slug */
	source: string;
	/** current subscription state, or "new" if not yet on the primary list */
	state: string;
	entry?: SubscriberEntry;
}

/**
 * Compute the recipient set for a blast: primary-list members (optional,
 * filterable) plus filtered extra-source entries. Unsubscribed/blocked
 * addresses are excluded everywhere. Pure — no writes.
 */
async function resolveRecipients(
	ctx: PluginContext,
	filtersRaw: string,
	includePrimary: boolean,
): Promise<ResolvedRecipient[]> {
	const filters = parseFilters(filtersRaw);
	const primarySlug = (await getCollection(ctx)).toLowerCase();
	const primary = await listAllSubscribers(ctx);
	const byEmail = new Map(primary.map((e) => [e.data.email, e]));
	const chosen = new Map<string, ResolvedRecipient>();

	if (includePrimary) {
		for (const e of primary) {
			if (e.data.subscription !== "confirmed" || e.data.blocked) continue;
			if (!matchesFilter(e.data as Record<string, unknown>, filters.get(primarySlug))) continue;
			chosen.set(e.data.email, { email: e.data.email, source: primarySlug, state: "confirmed", entry: e });
		}
	}

	const extras = await gatherExtraData(ctx, filters);
	for (const [email, data] of extras) {
		if (chosen.has(email)) continue;
		const source = typeof data._collection === "string" ? (data._collection as string) : "import";
		const existing = byEmail.get(email);
		if (existing) {
			// Suppression always wins, whatever the source.
			if (existing.data.subscription === "unsubscribed" || existing.data.blocked) continue;
			chosen.set(email, { email, source, state: existing.data.subscription, entry: existing });
		} else {
			chosen.set(email, { email, source, state: "new" });
		}
	}

	return [...chosen.values()];
}

async function enqueueBlast(
	ctx: PluginContext,
	subject: string,
	body: string,
	filtersRaw = "",
	includePrimary = true,
): Promise<{ blastId: string; total: number }> {
	const blastId = `blast_${Date.now()}_${randomToken().slice(0, 6)}`;
	const resolved = await resolveRecipients(ctx, filtersRaw, includePrimary);

	// Materialize extra-source recipients into the primary list so they get a
	// real unsubscribe token and future suppression works.
	const recipients: SubscriberEntry[] = [];
	for (const r of resolved) {
		if (r.entry) {
			recipients.push(r.entry);
			continue;
		}
		try {
			recipients.push(await upsertSubscriber(ctx, r.email, { subscription: "confirmed", source: r.source }));
		} catch (error) {
			ctx.log.error(`Mailing list: failed to materialize ${r.email}`, error);
		}
	}

	if (recipients.length > 0) {
		await sendsStore(ctx).putMany(
			recipients.map((e) => ({
				id: `${blastId}:${e.data.email}`,
				data: { blastId, email: e.data.email, status: "queued" as const, createdAt: now() },
			})),
		);
	}
	await blasts(ctx).put(blastId, {
		subject,
		body,
		filters: filtersRaw || undefined,
		includePrimary,
		status: "sending",
		total: recipients.length,
		sent: 0,
		delivered: 0,
		failed: 0,
		bounced: 0,
		createdAt: now(),
	});
	return { blastId, total: recipients.length };
}

// —————————————————————————————— webhook events ——————————————————————————————

async function handlePostalEvent(ctx: PluginContext, event: string, payload: Record<string, unknown>): Promise<string> {
	const message = (payload?.message ?? payload?.original_message ?? payload) as Record<string, unknown> | undefined;
	const email = normalizeEmail(message?.to);
	if (!email) return "ignored: no recipient";

	const entry = await findByEmail(ctx, email);
	const sendsForEmail = await sendsStore(ctx).query({ where: { email }, limit: 100 });
	const sendRow = sendsForEmail.items.slice().sort((a, b) => (a.data.createdAt < b.data.createdAt ? 1 : -1))[0];

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

	const block = async (reason: string) => {
		if (entry && !entry.data.blocked) {
			await upsertSubscriber(ctx, email, { blocked: true, bounce_reason: reason });
		}
	};

	switch (event) {
		case "MessageSent":
			await applySendStatus("delivered");
			return `delivered: ${email}`;

		case "MessageBounced":
			await applySendStatus("bounced", "bounced");
			await block("bounce received");
			return `bounced (blocked): ${email}`;

		case "MessageDeliveryFailed":
		case "MessageHeld": {
			const status = String((payload as Record<string, unknown>)?.status ?? "");
			if (status === "HardFail") {
				await applySendStatus("bounced", "hard delivery failure");
				await block(`HardFail: ${String((payload as Record<string, unknown>)?.details ?? "").slice(0, 200)}`);
				return `hard fail (blocked): ${email}`;
			}
			if (entry) {
				const softFails = (entry.data.soft_fails ?? 0) + 1;
				if (softFails >= 3 && !entry.data.blocked) {
					await applySendStatus("bounced", "3 soft failures");
					await upsertSubscriber(ctx, email, {
						soft_fails: softFails,
						blocked: true,
						bounce_reason: "3 consecutive soft delivery failures",
					});
					return `soft fail #${softFails} (blocked): ${email}`;
				}
				await upsertSubscriber(ctx, email, { soft_fails: softFails });
				return `soft fail #${softFails}: ${email}`;
			}
			return `soft fail (unknown subscriber): ${email}`;
		}

		default:
			return `ignored: ${event}`;
	}
}

// ——————————————————————————————— admin page ————————————————————————————————

async function buildAdminPage(
	ctx: PluginContext,
	preview?: { recipients: ResolvedRecipient[]; filtersRaw: string; includePrimary: boolean },
): Promise<Record<string, unknown>> {
	const available = await collectionAvailable(ctx);
	const collection = await getCollection(ctx);

	if (!available) {
		return {
			blocks: [
				{ type: "header", text: "Mailing List" },
				{
					type: "banner",
					title: `Collection "${collection}" not found`,
					description:
						"Subscribers are stored as regular CMS content. Create a collection with that slug (fields: email, status, blocked, token, soft_fails, bounce_reason) or set a different slug in KV settings:collection, then reload this page.",
					variant: "error",
				},
			],
		};
	}

	const all = await listAllSubscribers(ctx);
	const extras = await gatherExtraData(ctx);
	const primaryEmails = new Set(all.map((e) => e.data.email));
	const extraOnly = [...extras.keys()].filter((email) => !primaryEmails.has(email)).length;
	const confirmed =
		all.filter((e) => e.data.subscription === "confirmed" && !e.data.blocked).length + extraOnly;
	const pending = all.filter((e) => e.data.subscription === "pending").length;
	const unsubscribed = all.filter((e) => e.data.subscription === "unsubscribed").length;
	const blocked = all.filter((e) => e.data.blocked).length;

	const recent = all.slice(-12).reverse();
	const recentBlasts = await blasts(ctx).query({ orderBy: { createdAt: "desc" }, limit: 8 });

	const origin = await getOrigin(ctx);
	const secret = await getWebhookSecret(ctx);
	const listName = await getListName(ctx);
	const batchSize = (await ctx.kv.get<number>("settings:batchSize")) ?? 25;
	const template = (await ctx.kv.get<string>("settings:template")) ?? "";
	const collectionsCsv = (await getCollections(ctx)).join(", ");
	const webhookUrl = `${origin || "https://<your-site>"}/_emdash/api/plugins/emdash-mailing-list/webhook?key=${secret}`;
	const subscribeUrl = `${origin || "https://<your-site>"}/_emdash/api/plugins/emdash-mailing-list/subscribe`;

	const subscriberBlocks = recent.flatMap((e) => {
		const d = e.data;
		const flags = [d.subscription, d.blocked ? "BLOCKED" : null, d.bounce_reason ? `(${d.bounce_reason})` : null]
			.filter(Boolean)
			.join(" · ");
		const buttons: Array<Record<string, unknown>> = [];
		if (d.subscription === "pending") {
			buttons.push({ type: "button", action_id: "sub_confirm", value: d.email, label: "Confirm", style: "primary" });
		}
		buttons.push(
			d.blocked
				? { type: "button", action_id: "sub_unblock", value: d.email, label: "Unblock" }
				: { type: "button", action_id: "sub_block", value: d.email, label: "Block" },
		);
		buttons.push({
			type: "button",
			action_id: "sub_delete",
			value: d.email,
			label: "Delete",
			style: "danger",
			confirm: {
				title: "Delete subscriber?",
				text: `Permanently remove ${d.email} from the list. This cannot be undone.`,
				confirm: "Delete",
				deny: "Cancel",
			},
		});
		return [
			{ type: "section", text: `${d.email} — ${flags}` },
			{ type: "actions", elements: buttons },
			{ type: "divider" },
		];
	});

	return {
		blocks: [
			{ type: "header", text: "Mailing List" },
			{
				type: "stats",
				items: [
					{ label: "Sendable", value: confirmed, description: extraOnly ? `${extraOnly} from extra sources` : undefined },
					{ label: "Pending", value: pending },
					{ label: "Blocked", value: blocked, description: "bounced or manually blocked" },
					{ label: "Unsubscribed", value: unsubscribed },
				],
			},
			{
				type: "context",
				text: `Subscribers live in the “${collection}” content collection — browse and edit them under Content, and add custom fields (e.g. is_wine_club_member) in the schema editor. Every field works as a {{merge_tag}} in blasts.`,
			},

			{ type: "header", text: "Send a blast" },
			{
				type: "section",
				text: `Markdown supported: **bold**, *italic*, [links](https://…), # headings, - lists. Merge tags like {{email}} (or any subscriber field) are replaced per recipient. Sends go to ${confirmed} sendable subscribers in batches of ${batchSize}/minute; an unsubscribe link is added automatically.`,
			},
			{
				type: "form",
				block_id: "compose",
				fields: [
					{ type: "text_input", action_id: "subject", label: "Subject" },
					{ type: "text_input", action_id: "body", label: "Message (Markdown)", multiline: true },
					{
						type: "toggle",
						action_id: "include_primary",
						label: "Include the subscribers list (untick to target only the extra source collections)",
						initial_value: true,
					},
					{
						type: "text_input",
						action_id: "filters",
						label: "Recipient filter (optional) — one line per collection, e.g. “attendees: year=2026, void=false”. Works for the subscribers list too. Unlisted collections are unfiltered.",
						multiline: true,
						placeholder: "attendees: year=2026, void=false",
					},
					{
						type: "toggle",
						action_id: "preview",
						label: "Evaluate only — show who would receive it, without sending",
						initial_value: false,
					},
					{
						type: "text_input",
						action_id: "test_to",
						label: "Send a test to this address instead (leave empty to send the real blast)",
						placeholder: "you@example.com",
					},
				],
				submit: { label: "Send / Evaluate", action_id: "send_blast" },
			},
			...(preview
				? [
						{
							type: "banner",
							title: `Evaluation: ${preview.recipients.length} recipients`,
							description: `Filters: ${preview.filtersRaw.trim() || "(none)"} · Subscribers list ${preview.includePrimary ? "included" : "excluded"}. Nothing was sent.`,
							variant: "default",
						},
						{
							type: "table",
							page_action_id: "preview_page",
							empty_text: "No one matches — nothing would be sent.",
							columns: [
								{ key: "email", label: "Email" },
								{ key: "source", label: "Source" },
								{ key: "state", label: "State" },
							],
							rows: preview.recipients.slice(0, 100).map((r) => ({
								email: r.email,
								source: r.source,
								state: r.state === "new" ? "new (will be added to subscribers)" : r.state,
							})),
						},
						...(preview.recipients.length > 100
							? [{ type: "context", text: `…and ${preview.recipients.length - 100} more.` }]
							: []),
					]
				: []),

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

			{ type: "header", text: `Subscribers (latest ${recent.length} of ${all.length})` },
			...subscriberBlocks,
			{
				type: "form",
				block_id: "manual",
				fields: [{ type: "text_input", action_id: "email", label: "Add subscriber (immediately confirmed)" }],
				submit: { label: "Add", action_id: "manual_add" },
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
					{
						type: "text_input",
						action_id: "contactTo",
						label: "Contact form recipient (blank disables the contact endpoint)",
						initial_value: (await ctx.kv.get<string>("settings:contactTo")) ?? "",
					},
					{
						type: "text_input",
						action_id: "collections",
						label: "Source collections (comma-separated; first is the primary list, extras like an attendees collection just need an email field)",
						initial_value: collectionsCsv,
					},
					{
						type: "text_input",
						action_id: "template",
						label: "HTML email template — {{content}} is replaced with the rendered message; also available: {{subject}}, {{unsubscribe_url}}, {{list_name}}. Leave empty for the plain default.",
						multiline: true,
						initial_value: template,
					},
				],
				submit: { label: "Save Settings", action_id: "save_settings" },
			},

			{ type: "header", text: "Wiring" },
			{
				type: "section",
				text: "Signup endpoint — POST JSON `{ \"email\": \"...\" }` from your site's form. Confirmation/unsubscribe emails link to /mailing/confirm and /mailing/unsubscribe pages on your site (see README).",
			},
			{ type: "code", code: subscribeUrl, language: "bash" },
			{
				type: "section",
				text: "Postal webhook (Server → Webhooks; events MessageSent, MessageDeliveryFailed, MessageBounced, MessageHeld). Hard bounces block the address automatically; three soft failures do the same. Blocked subscribers stay on the list but never receive sends until unblocked.",
			},
			{ type: "code", code: webhookUrl, language: "bash" },
		],
	};
}

async function adminWithToast(ctx: PluginContext, message: string, type: "success" | "error"): Promise<Record<string, unknown>> {
	return { ...(await buildAdminPage(ctx)), toast: { message, type } };
}

// ————————————————————————————————— plugin ——————————————————————————————————

export default definePlugin({
	id: "emdash-mailing-list",
	version: "0.2.0",
	storage: {
		// v0.1 legacy — kept so existing rows can be migrated into the collection.
		subscribers: { indexes: ["email", "status", "token", "createdAt"] },
		blasts: { indexes: ["status", "createdAt"] },
		sends: { indexes: ["blastId", "email", "status", "createdAt"] },
	},
	hooks: {
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				await getWebhookSecret(ctx);
				await ensureCron(ctx);
			},
		},
		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "process-queue") {
					await ctx.kv.set("state:lastCron", now());
					await processQueue(ctx);
				}
			},
		},
	},

	routes: {
		subscribe: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				const ctx = (hostCtx ?? rctx) as PluginContext;
				await rememberOrigin(ctx, rctx.request);
				await ensureCron(ctx);
				const input = (rctx.input ?? {}) as Record<string, unknown>;
				if (typeof input.website === "string" && input.website.trim() !== "") {
					return { ok: true }; // honeypot
				}
				const email = normalizeEmail(input.email);
				if (!email) return { ok: false, error: "invalid_email" };
				if (!(await collectionAvailable(ctx))) return { ok: false, error: "not_configured" };

				const existing = await findByEmail(ctx, email);
				if (existing?.data.subscription === "confirmed" && !existing.data.blocked) {
					return { ok: true, already: true };
				}
				const entry = await upsertSubscriber(ctx, email, {
					subscription: "pending",
					source: (existing?.data.source as string) ?? "signup",
					token: existing?.data.token ?? randomToken(),
				});
				await sendConfirmationEmail(ctx, entry.data);
				return { ok: true };
			},
		},

		/**
		 * POST { name, email, subject?, message } — public contact form.
		 * Sends to settings:contactTo, CCs the submitter, sets Reply-To so
		 * replies go straight back to them. Honeypot field: website.
		 */
		contact: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				const ctx = (hostCtx ?? rctx) as PluginContext;
				await rememberOrigin(ctx, rctx.request);
				const input = (rctx.input ?? {}) as Record<string, unknown>;
				if (typeof input.website === "string" && input.website.trim() !== "") {
					return { ok: true }; // honeypot
				}
				const email = normalizeEmail(input.email);
				const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
				const subject = typeof input.subject === "string" ? input.subject.trim().slice(0, 200) : "";
				const message = typeof input.message === "string" ? input.message.trim().slice(0, 5000) : "";
				if (!email) return { ok: false, error: "invalid_email" };
				if (!name || !message) return { ok: false, error: "missing_fields" };
				const contactTo = await ctx.kv.get<string>("settings:contactTo");
				if (!contactTo) return { ok: false, error: "not_configured" };
				if (!ctx.email) return { ok: false, error: "no_email_provider" };

				const fullSubject = `[Contact] ${subject || "New message"} — ${name}`;
				const text = `New contact form message

From: ${name} <${email}>
Subject: ${subject || "(none)"}

${message}

—
Sent from the website contact form. Reply goes to the sender; they received a copy (CC).`;
				const html = `<p><strong>New contact form message</strong></p>
<p>From: ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;<br>Subject: ${escapeHtml(subject || "(none)")}</p>
<blockquote style="border-left:3px solid #ccc;margin:12px 0;padding:4px 12px;white-space:pre-wrap">${escapeHtml(message)}</blockquote>
<p style="font-size:12px;color:#777">Sent from the website contact form. Reply goes to the sender; they received a copy (CC).</p>`;

				// cc / replyTo ride through the pipeline to transports that honor
				// them (emdash-postal >= 0.2.0).
				await ctx.email.send({
					to: contactTo,
					subject: fullSubject,
					text,
					html,
					cc: email,
					replyTo: email,
				} as Parameters<NonNullable<PluginContext["email"]>["send"]>[0]);
				return { ok: true };
			},
		},

		confirm: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				const ctx = (hostCtx ?? rctx) as PluginContext;
				await rememberOrigin(ctx, rctx.request);
				const token =
					String((rctx.input as Record<string, unknown>)?.token ?? "") ||
					(new URL(rctx.request.url).searchParams.get("token") ?? "");
				const entry = await findByToken(ctx, token);
				if (!entry) return { ok: false, state: "invalid" };
				await upsertSubscriber(ctx, entry.data.email, { subscription: "confirmed", soft_fails: 0 });
				return { ok: true, state: "confirmed" };
			},
		},

		unsubscribe: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				const ctx = (hostCtx ?? rctx) as PluginContext;
				await rememberOrigin(ctx, rctx.request);
				const token =
					String((rctx.input as Record<string, unknown>)?.token ?? "") ||
					(new URL(rctx.request.url).searchParams.get("token") ?? "");
				const entry = await findByToken(ctx, token);
				if (entry && entry.data.subscription !== "unsubscribed") {
					await upsertSubscriber(ctx, entry.data.email, { subscription: "unsubscribed" });
				}
				return { ok: entry != null, state: entry ? "unsubscribed" : "invalid" };
			},
		},

		webhook: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				const ctx = (hostCtx ?? rctx) as PluginContext;
				const url = new URL(rctx.request.url);
				const key = url.searchParams.get("key") ?? "";
				const secret = await ctx.kv.get<string>("state:webhookSecret");
				if (!secret || key !== secret) return { ok: false, error: "unauthorized" };
				const body = (rctx.input ?? {}) as Record<string, unknown>;
				const event = String(body.event ?? "");
				const payload = (body.payload ?? {}) as Record<string, unknown>;
				const result = await handlePostalEvent(ctx, event, payload);
				ctx.log.info(`Postal webhook: ${event} → ${result}`);
				return { ok: true, result };
			},
		},

		/**
		 * GET — public watchdog for uptime monitoring. Checks the database (a
		 * real D1 read), the email provider, and the send-queue cron heartbeat.
		 * Keyword-monitor on "healthy": the overall status is only "healthy"
		 * when every check passes.
		 */
		health: {
			public: true,
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				const ctx = (hostCtx ?? rctx) as PluginContext;
				const checks: Record<string, unknown> = {};

				let database = false;
				try {
					await contentApi(ctx).list(await getCollection(ctx), { limit: 1 });
					database = true;
				} catch {
					database = false;
				}
				checks.database = database ? "up" : "down";

				const emailProvider = Boolean(ctx.email);
				checks.email_provider = emailProvider ? "configured" : "missing";

				const lastCron = await ctx.kv.get<string>("state:lastCron");
				const cronAge = lastCron ? Math.round((Date.now() - new Date(lastCron).getTime()) / 1000) : null;
				checks.cron_age_seconds = cronAge;
				// Tolerate 5 minutes of missed ticks; null means the cron has never
				// run (fresh install) — degraded so setup problems surface.
				const cronOk = cronAge !== null && cronAge < 300;
				checks.cron = cronOk ? "beating" : "stale";

				let queueOk = true;
				try {
					const queued = await sendsStore(ctx).count({ status: "queued" });
					checks.queued_sends = queued;
					// A backlog with a dead cron means blasts are silently stuck.
					queueOk = queued === 0 || cronOk;
				} catch {
					queueOk = false;
					checks.queued_sends = "unknown";
				}

				const healthy = database && emailProvider && cronOk && queueOk;
				return { status: healthy ? "healthy" : "degraded", checks, ts: now() };
			},
		},

		admin: {
			handler: async (rctx: RC, hostCtx?: PluginContext) => {
				const ctx = (hostCtx ?? rctx) as PluginContext;
				await rememberOrigin(ctx, rctx.request);
				const interaction = rctx.input as {
					type: string;
					page?: string;
					action_id?: string;
					value?: unknown;
					values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load") {
					await ensureCron(ctx);
					await migrateLegacySubscribers(ctx);
					return buildAdminPage(ctx);
				}

				// Per-subscriber row actions
				if (interaction.type === "block_action" && interaction.action_id?.startsWith("sub_")) {
					const email = normalizeEmail(interaction.value);
					if (!email) return adminWithToast(ctx, "Missing subscriber email", "error");
					const entry = await findByEmail(ctx, email);
					if (!entry) return adminWithToast(ctx, `${email} not found`, "error");
					switch (interaction.action_id) {
						case "sub_confirm":
							await upsertSubscriber(ctx, email, { subscription: "confirmed", soft_fails: 0 });
							return adminWithToast(ctx, `${email} confirmed`, "success");
						case "sub_block":
							await upsertSubscriber(ctx, email, { blocked: true, bounce_reason: "manually blocked" });
							return adminWithToast(ctx, `${email} blocked`, "success");
						case "sub_unblock":
							await upsertSubscriber(ctx, email, { blocked: false, soft_fails: 0, bounce_reason: "" });
							return adminWithToast(ctx, `${email} unblocked`, "success");
						case "sub_delete": {
							const collection = await getCollection(ctx);
							await contentApi(ctx).delete(collection, entry.id);
							await ctx.kv.delete(`tok:${entry.data.token}`);
							return adminWithToast(ctx, `${email} deleted`, "success");
						}
					}
				}

				if (interaction.type === "block_action") return buildAdminPage(ctx);

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					const values = interaction.values ?? {};
					if (typeof values.listName === "string" && values.listName.trim()) {
						await ctx.kv.set("settings:listName", values.listName.trim());
					}
					const batch = Number(values.batchSize);
					if (Number.isFinite(batch) && batch >= 1 && batch <= 100) {
						await ctx.kv.set("settings:batchSize", Math.floor(batch));
					}
					if (typeof values.template === "string") {
						await ctx.kv.set("settings:template", values.template.trim());
					}
					if (typeof values.collections === "string" && values.collections.trim()) {
						await ctx.kv.set("settings:collections", values.collections.trim());
					}
					if (typeof values.contactTo === "string") {
						await ctx.kv.set("settings:contactTo", values.contactTo.trim());
					}
					return adminWithToast(ctx, "Settings saved", "success");
				}

				if (interaction.type === "form_submit" && interaction.action_id === "manual_add") {
					const email = normalizeEmail(interaction.values?.email);
					if (!email) return adminWithToast(ctx, "Invalid email address", "error");
					await upsertSubscriber(ctx, email, { subscription: "confirmed", source: "manual" });
					return adminWithToast(ctx, `${email} added as confirmed`, "success");
				}

				if (interaction.type === "form_submit" && interaction.action_id === "send_blast") {
					const values = interaction.values ?? {};
					const subject = typeof values.subject === "string" ? values.subject.trim() : "";
					const body = typeof values.body === "string" ? values.body.trim() : "";
					const testTo = normalizeEmail(values.test_to);
					const filtersRaw = typeof values.filters === "string" ? values.filters : "";
					const includePrimary = values.include_primary !== false;
					const previewOnly = values.preview === true;

					if (previewOnly) {
						try {
							const recipients = await resolveRecipients(ctx, filtersRaw, includePrimary);
							return {
								...(await buildAdminPage(ctx, { recipients, filtersRaw, includePrimary })),
								toast: { message: `${recipients.length} recipients match — nothing sent`, type: "info" },
							};
						} catch (error) {
							return adminWithToast(ctx, `Error: ${error instanceof Error ? error.message : String(error)}`, "error");
						}
					}

					if (!subject || !body) return adminWithToast(ctx, "Subject and message are required", "error");

					try {
						if (testTo) {
							if (!ctx.email) throw new Error("No email provider is configured");
							const testSub: SubscriberData = {
								email: testTo,
								subscription: "confirmed",
								blocked: false,
								token: "test",
								soft_fails: 0,
							};
							const rendered = await renderEmail(ctx, subject, body, testSub);
							await ctx.email.send({
								to: testTo,
								subject: `[TEST] ${rendered.subject}`,
								text: rendered.text,
								html: rendered.html,
							});
							return adminWithToast(ctx, `Test sent to ${testTo}`, "success");
						}
						await ensureCron(ctx);
						const { total } = await enqueueBlast(ctx, subject, body, filtersRaw, includePrimary);
						if (total === 0) return adminWithToast(ctx, "No sendable subscribers", "error");
						return adminWithToast(ctx, `Blast queued to ${total} subscribers — sending starts within a minute`, "success");
					} catch (error) {
						return adminWithToast(ctx, `Error: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}

				return { blocks: [] };
			},
		},
	},
});
