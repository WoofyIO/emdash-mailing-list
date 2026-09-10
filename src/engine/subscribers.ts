/**
 * Subscribers are regular CMS content entries in the primary source collection
 * (default `subscribers`), so admins can browse them under Content and add
 * fields that then work as merge tags. Plugin storage only keeps the sending
 * machinery. A `tok:<token>` KV index makes confirm/unsubscribe links O(1).
 */
import type { PluginContext } from "emdash";

import { getCollection, normalizeEmail, randomToken } from "./settings.js";

export interface SubscriberData {
	email: string;
	subscription: "pending" | "confirmed" | "unsubscribed";
	blocked: boolean;
	token: string;
	soft_fails: number;
	bounce_reason?: string;
	source?: string;
	title?: string;
	[key: string]: unknown; // admin-added custom fields (merge tags)
}

export interface SubscriberEntry {
	id: string;
	slug: string | null;
	data: SubscriberData;
}

interface GenericEntry {
	id: string;
	slug: string | null;
	data: Record<string, unknown>;
}

export interface ContentApi {
	get(collection: string, id: string): Promise<GenericEntry | null>;
	list(collection: string, options?: object): Promise<{ items: GenericEntry[]; cursor?: string; hasMore: boolean }>;
	create(collection: string, data: object): Promise<GenericEntry>;
	update(collection: string, id: string, data: object): Promise<GenericEntry>;
	delete(collection: string, id: string): Promise<boolean>;
}

export function contentApi(ctx: PluginContext): ContentApi {
	if (!ctx.content) throw new Error("Missing content capability");
	return ctx.content as unknown as ContentApi;
}

/** Whether the primary collection exists — the plugin degrades politely if not. */
export async function collectionAvailable(ctx: PluginContext): Promise<boolean> {
	try {
		await contentApi(ctx).list(await getCollection(ctx), { limit: 1 });
		return true;
	} catch {
		return false;
	}
}

/** Every entry of a collection, paginated. Capped so a runaway list can't hang a request. */
export async function listAllEntries(ctx: PluginContext, collection: string, cap = 10_000): Promise<GenericEntry[]> {
	const api = contentApi(ctx);
	const all: GenericEntry[] = [];
	let cursor: string | undefined;
	do {
		const page = await api.list(collection, { limit: 100, cursor });
		all.push(...page.items);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && all.length < cap);
	return all;
}

export async function listAllSubscribers(ctx: PluginContext): Promise<SubscriberEntry[]> {
	const entries = await listAllEntries(ctx, await getCollection(ctx));
	return entries.filter((e) => typeof e.data?.email === "string") as SubscriberEntry[];
}

export async function findByEmail(ctx: PluginContext, email: string): Promise<SubscriberEntry | null> {
	const all = await listAllSubscribers(ctx);
	return all.find((e) => e.data.email === email) ?? null;
}

export async function findByToken(ctx: PluginContext, token: string): Promise<SubscriberEntry | null> {
	if (!token) return null;
	const collection = await getCollection(ctx);
	const knownId = await ctx.kv.get<string>(`tok:${token}`);
	if (knownId) {
		const entry = (await contentApi(ctx)
			.get(collection, knownId)
			.catch(() => null)) as SubscriberEntry | null;
		if (entry?.data?.token === token) return entry;
	}
	const all = await listAllSubscribers(ctx);
	const match = all.find((e) => e.data.token === token) ?? null;
	if (match) await ctx.kv.set(`tok:${token}`, match.id);
	return match;
}

/** Title mirrors state so the admin Content list reads at a glance. */
export function subscriberTitle(d: Pick<SubscriberData, "email" | "subscription" | "blocked">): string {
	if (d.blocked) return `${d.email} — blocked`;
	if (d.subscription !== "confirmed") return `${d.email} — ${d.subscription}`;
	return d.email;
}

export async function upsertSubscriber(
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
		return (await api.update(collection, existing.id, { ...patch, title: subscriberTitle(merged) })) as SubscriberEntry;
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
	const entry = (await api.create(collection, { ...data })) as SubscriberEntry;
	await ctx.kv.set(`tok:${token}`, entry.id);
	return entry;
}

export async function deleteSubscriber(ctx: PluginContext, entry: SubscriberEntry): Promise<void> {
	await contentApi(ctx).delete(await getCollection(ctx), entry.id);
	await ctx.kv.delete(`tok:${entry.data.token}`);
}

export interface SubscriberCounts {
	confirmed: number;
	pending: number;
	blocked: number;
	unsubscribed: number;
	total: number;
}

export function countSubscribers(all: SubscriberEntry[]): SubscriberCounts {
	const counts: SubscriberCounts = { confirmed: 0, pending: 0, blocked: 0, unsubscribed: 0, total: all.length };
	for (const { data } of all) {
		if (data.blocked) counts.blocked += 1;
		else if (data.subscription === "confirmed") counts.confirmed += 1;
		else if (data.subscription === "pending") counts.pending += 1;
		else if (data.subscription === "unsubscribed") counts.unsubscribed += 1;
	}
	return counts;
}

/** One-time migration from the 0.1 plugin-storage subscribers to the collection. */
export async function migrateLegacySubscribers(ctx: PluginContext): Promise<void> {
	const legacy = (ctx.storage as Record<string, unknown>).subscribers as
		| {
				query(o?: object): Promise<{ items: Array<{ id: string; data: Record<string, unknown> }> }>;
				delete(id: string): Promise<boolean>;
		  }
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
