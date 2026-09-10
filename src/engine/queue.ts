/**
 * Blasts and the send queue.
 *
 * A blast fans out into one `sends` row per recipient; a once-a-minute cron
 * drains them in rate-limited batches through the site's email provider.
 * Delivery outcomes arrive later from Postal's webhooks and update the rows
 * and the blast's counters (see postal-events.ts).
 *
 * The `outbox` holds one-off transactional mail — the contact form's
 * operator copy and acknowledgement — so a public route never sends inline.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { renderEmail, type BlastContent, type PortableTextBlocks } from "./render.js";
import { getBatchSize, getOrigin, now, pagePath, randomToken } from "./settings.js";
import { findByEmail, upsertSubscriber, type SubscriberData, type SubscriberEntry } from "./subscribers.js";
import { gatherExtraData, resolveRecipients } from "./targeting.js";

export interface Blast {
	subject: string;
	/** Markdown body (legacy). */
	body: string;
	/** Portable Text body (admin-composed). */
	bodyPT?: PortableTextBlocks;
	filters?: string;
	includePrimary?: boolean;
	status: "sending" | "sent";
	total: number;
	sent: number;
	delivered: number;
	failed: number;
	bounced: number;
	/** Unique recipients, not raw events — one person opening five times counts once. */
	opened: number;
	clicked: number;
	delayed: number;
	held: number;
	createdAt: string;
	completedAt?: string;
}

export interface Send {
	blastId: string;
	email: string;
	status: "queued" | "sent" | "delivered" | "failed" | "bounced" | "delayed" | "held";
	error?: string;
	createdAt: string;
	sentAt?: string;
	/** First open / first click. Presence is what de-duplicates the counters. */
	openedAt?: string;
	clickedAt?: string;
}

export interface OutboxItem {
	to: string;
	subject: string;
	text: string;
	html: string;
	replyTo?: string;
	createdAt: string;
	attempts: number;
}

export const STORAGE_CONFIG = {
	// 0.1 legacy rows — migrated into the collection on first admin load.
	subscribers: { indexes: ["email", "status", "token", "createdAt"] },
	blasts: { indexes: ["status", "createdAt"] },
	sends: { indexes: ["blastId", "email", "status", "createdAt"] },
	outbox: { indexes: ["createdAt"] },
};

export const QUEUE_TASK = "process-queue";

export const blasts = (ctx: PluginContext) => ctx.storage.blasts as StorageCollection<Blast>;
export const sendsStore = (ctx: PluginContext) => ctx.storage.sends as StorageCollection<Send>;
export const outbox = (ctx: PluginContext) => ctx.storage.outbox as StorageCollection<OutboxItem>;

export async function ensureCron(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) return;
	try {
		const existing = await ctx.cron.list();
		if (!existing.some((t) => t.name === QUEUE_TASK)) {
			await ctx.cron.schedule(QUEUE_TASK, { schedule: "* * * * *" });
			ctx.log.info("Mailing list send queue scheduled");
		}
	} catch (error) {
		ctx.log.error("Failed to schedule send queue", error);
	}
}

/**
 * RFC 8058 one-click unsubscribe headers. Gmail and Yahoo require these of
 * bulk senders, and Apple weights them. The URI is the plugin's own API route
 * rather than the human-facing page: one-click sends an unattended POST, so
 * the target must unsubscribe server-side without rendering anything.
 */
export async function unsubscribeHeaders(ctx: PluginContext, token: string): Promise<Record<string, string>> {
	const origin = await getOrigin(ctx);
	const apiUrl = `${origin}/_emdash/api/plugins/emdash-mailing-list/unsubscribe?token=${encodeURIComponent(token)}`;
	const pageUrl = `${origin}${await pagePath(ctx, "unsubscribe")}?token=${encodeURIComponent(token)}`;
	return {
		"List-Unsubscribe": `<${apiUrl}>, <${pageUrl}>`,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	};
}

type SendMessage = Parameters<NonNullable<PluginContext["email"]>["send"]>[0];

export async function enqueueBlast(
	ctx: PluginContext,
	content: BlastContent,
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
		subject: content.subject,
		body: content.body ?? "",
		bodyPT: content.bodyPT,
		filters: filtersRaw || undefined,
		includePrimary,
		status: "sending",
		total: recipients.length,
		sent: 0,
		delivered: 0,
		failed: 0,
		bounced: 0,
		opened: 0,
		clicked: 0,
		delayed: 0,
		held: 0,
		createdAt: now(),
	});
	await ensureCron(ctx);
	return { blastId, total: recipients.length };
}

/** Send a rendered blast to one address, with the same headers a real send carries. */
export async function sendTest(ctx: PluginContext, content: BlastContent, to: string): Promise<void> {
	if (!ctx.email) throw new Error("No email provider is configured");
	const existing = await findByEmail(ctx, to);
	const sub: SubscriberData = existing?.data ?? {
		email: to,
		subscription: "confirmed",
		blocked: false,
		token: "test",
		soft_fails: 0,
	};
	const extras = await gatherExtraData(ctx);
	const rendered = await renderEmail(ctx, content, { ...(extras.get(to) ?? {}), ...sub } as SubscriberData);
	await ctx.email.send({
		to,
		subject: `[TEST] ${rendered.subject}`,
		text: rendered.text,
		html: rendered.html,
		headers: await unsubscribeHeaders(ctx, sub.token),
	} as SendMessage);
}

/**
 * Drain one-off transactional mail. A permanently failing message is dropped
 * after three attempts rather than retried for ever.
 */
export async function processOutbox(ctx: PluginContext): Promise<void> {
	if (!ctx.email) return;
	const pending = await outbox(ctx).query({ limit: 25 });
	for (const item of pending.items) {
		const d = item.data;
		try {
			await ctx.email.send({
				to: d.to,
				subject: d.subject,
				text: d.text,
				html: d.html,
				...(d.replyTo ? { replyTo: d.replyTo } : {}),
			} as SendMessage);
			await outbox(ctx).delete(item.id);
		} catch (error) {
			const attempts = (d.attempts ?? 0) + 1;
			if (attempts >= 3) {
				ctx.log.error(`Giving up on queued mail to ${d.to} after 3 attempts`, error);
				await outbox(ctx).delete(item.id);
			} else {
				await outbox(ctx).put(item.id, { ...d, attempts });
			}
		}
	}
}

export async function processQueue(ctx: PluginContext): Promise<void> {
	const batchSize = await getBatchSize(ctx);
	const queued = await sendsStore(ctx).query({ where: { status: "queued" }, limit: batchSize });
	if (queued.items.length === 0) return;
	if (!ctx.email) {
		ctx.log.error("Mailing list: queued sends but no email provider configured");
		return;
	}

	const blastCache = new Map<string, Blast>();
	const touched = new Set<string>();
	const extras = await gatherExtraData(ctx);

	for (const { id, data: send } of queued.items) {
		const blast = blastCache.get(send.blastId) ?? (await blasts(ctx).get(send.blastId));
		if (!blast) {
			await sendsStore(ctx).put(id, { ...send, status: "failed", error: "blast missing" });
			continue;
		}
		blastCache.set(send.blastId, blast);
		touched.add(send.blastId);

		const entry = await findByEmail(ctx, send.email);
		const sub = entry?.data;
		if (!sub || sub.subscription !== "confirmed" || sub.blocked) {
			await sendsStore(ctx).put(id, { ...send, status: "failed", error: "not subscribed or blocked" });
			blast.failed += 1;
			continue;
		}

		try {
			// Extra-source fields merge under the primary record so they work as merge tags.
			const merged = { ...(extras.get(send.email) ?? {}), ...sub } as SubscriberData;
			const rendered = await renderEmail(ctx, blast, merged);
			await ctx.email.send({
				to: send.email,
				subject: rendered.subject,
				text: rendered.text,
				html: rendered.html,
				headers: await unsubscribeHeaders(ctx, sub.token),
			} as SendMessage);
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

	for (const blastId of touched) {
		const blast = blastCache.get(blastId)!;
		const remaining = await sendsStore(ctx).count({ blastId, status: "queued" });
		if (remaining === 0 && blast.status === "sending") {
			blast.status = "sent";
			blast.completedAt = now();
		}
		await blasts(ctx).put(blastId, blast);
	}
}

/** Blast rows for the admin, with engagement rates against delivered. */
export interface BlastSummary {
	id: string;
	subject: string;
	status: Blast["status"];
	total: number;
	sent: number;
	delivered: number;
	failed: number;
	bounced: number;
	opened: number;
	clicked: number;
	delayed: number;
	held: number;
	openRate: number | null;
	clickRate: number | null;
	createdAt: string;
	completedAt: string | null;
	hasRichBody: boolean;
}

export function summarize(id: string, b: Blast): BlastSummary {
	// Rates are against delivered, not sent: a message that never arrived
	// can't be opened, and dividing by sent understates engagement whenever
	// anything bounces.
	const base = b.delivered || b.sent || 0;
	const rate = (n: number) => (base > 0 ? Math.round((n / base) * 100) : null);
	return {
		id,
		subject: b.subject,
		status: b.status,
		total: b.total,
		sent: b.sent,
		delivered: b.delivered,
		failed: b.failed,
		bounced: b.bounced,
		opened: b.opened ?? 0,
		clicked: b.clicked ?? 0,
		delayed: b.delayed ?? 0,
		held: b.held ?? 0,
		openRate: rate(b.opened ?? 0),
		clickRate: rate(b.clicked ?? 0),
		createdAt: b.createdAt,
		completedAt: b.completedAt ?? null,
		hasRichBody: Array.isArray(b.bodyPT) && b.bodyPT.length > 0,
	};
}
