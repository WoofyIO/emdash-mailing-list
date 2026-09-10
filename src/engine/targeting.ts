/**
 * Who a blast goes to.
 *
 * The primary list plus any number of extra source collections (an attendees
 * list, a waitlist…) that only need an `email` field. Selection arrives from
 * the compose page as checkboxes and is compiled to the same filter syntax the
 * engine has always understood, so scripted callers and the advanced box keep
 * working:
 *
 *   attendees: event=spring, event=summer, void=false
 *
 * Pairs for the same key are ORed, different keys ANDed.
 */
import type { PluginContext } from "emdash";

import { getCollections, getGroupFields, normalizeEmail } from "./settings.js";
import { contentApi, listAllEntries, listAllSubscribers, type SubscriberEntry } from "./subscribers.js";

export type RecipientFilters = Map<string, Array<[string, string]>>;

export function parseFilters(raw: string): RecipientFilters {
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

function matchesOne(actual: unknown, expected: string): boolean {
	const exp = expected.toLowerCase();
	if (exp === "true" || exp === "false") return Boolean(actual) === (exp === "true");
	if (actual === undefined || actual === null) return exp === "";
	if (typeof actual === "number" && !Number.isNaN(Number(expected))) return actual === Number(expected);
	return String(actual).toLowerCase() === exp;
}

export function matchesFilter(data: Record<string, unknown>, pairs: Array<[string, string]> | undefined): boolean {
	if (!pairs) return true;
	const byKey = new Map<string, string[]>();
	for (const [key, expected] of pairs) {
		const list = byKey.get(key) ?? [];
		list.push(expected);
		byKey.set(key, list);
	}
	for (const [key, expectations] of byKey) {
		if (!expectations.some((exp) => matchesOne(data[key], exp))) return false;
	}
	return true;
}

export interface GroupValue {
	value: string;
	count: number;
}

export interface SourceOption {
	collection: string;
	/** Group field, if configured for this source. */
	field: string | null;
	values: GroupValue[];
	/** Entries carrying an email. */
	total: number;
}

/** Each extra source with its group values and counts, for the compose page. */
export async function describeSources(ctx: PluginContext): Promise<SourceOption[]> {
	const [, ...extras] = await getCollections(ctx);
	const groupFields = await getGroupFields(ctx);
	const out: SourceOption[] = [];
	for (const collection of extras) {
		const field = groupFields.get(collection.toLowerCase()) ?? null;
		const counts = new Map<string, number>();
		let total = 0;
		try {
			for (const entry of await listAllEntries(ctx, collection)) {
				if (!normalizeEmail(entry.data?.email)) continue;
				total += 1;
				if (!field) continue;
				const raw = entry.data[field];
				if (raw === undefined || raw === null || raw === "") continue;
				const value = String(raw);
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
		} catch (error) {
			ctx.log.error(`Mailing list: cannot read source collection "${collection}"`, error);
		}
		out.push({
			collection,
			field,
			total,
			values: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
		});
	}
	return out;
}

/** The compose page's selection, as sent by the admin UI. */
export interface TargetSelection {
	includePrimary: boolean;
	/** collection → include it at all, and which group values (undefined = all). */
	sources: Record<string, { include: boolean; values?: string[] }>;
	/** Raw filter lines ANDed on top. */
	advanced?: string;
}

/**
 * Compile checkboxes to filter syntax. An extra source with every value ticked
 * stays unfiltered; with none ticked (or unticked itself) it is excluded via
 * an impossible filter, which is the only way the engine can say "none".
 */
export async function compileSelection(ctx: PluginContext, selection: TargetSelection): Promise<string> {
	const sources = await describeSources(ctx);
	const lines: string[] = [];
	for (const source of sources) {
		const pick = selection.sources[source.collection];
		if (pick && pick.include === false) {
			lines.push(`${source.collection}: __excluded__=true`);
			continue;
		}
		if (!source.field || !pick?.values || source.values.length === 0) continue;
		const chosen = source.values.filter((v) => pick.values!.includes(v.value));
		if (chosen.length === source.values.length) continue;
		if (chosen.length === 0) {
			lines.push(`${source.collection}: __excluded__=true`);
			continue;
		}
		lines.push(`${source.collection}: ${chosen.map((v) => `${source.field}=${v.value}`).join(", ")}`);
	}
	return [...lines, (selection.advanced ?? "").trim()].filter(Boolean).join("\n");
}

/**
 * Recipient data from EXTRA source collections: email → entry data
 * (+ _collection), first occurrence wins. Their fields become merge tags.
 */
export async function gatherExtraData(
	ctx: PluginContext,
	filters?: RecipientFilters,
): Promise<Map<string, Record<string, unknown>>> {
	const [, ...extras] = await getCollections(ctx);
	const map = new Map<string, Record<string, unknown>>();
	for (const collection of extras) {
		const pairs = filters?.get(collection.toLowerCase());
		try {
			for (const entry of await listAllEntries(ctx, collection)) {
				const email = normalizeEmail(entry.data?.email);
				if (!email || map.has(email)) continue;
				if (!matchesFilter(entry.data, pairs)) continue;
				map.set(email, { ...entry.data, _collection: collection });
			}
		} catch (error) {
			ctx.log.error(`Mailing list: cannot read source collection "${collection}"`, error);
		}
	}
	return map;
}

export interface ResolvedRecipient {
	email: string;
	/** Primary collection slug for list members, else the extra collection slug. */
	source: string;
	/** Current subscription state, or "new" if not yet on the primary list. */
	state: string;
	entry?: SubscriberEntry;
}

/**
 * Compute the recipient set: primary-list members (optional, filterable) plus
 * filtered extra-source entries. Unsubscribed/blocked addresses are excluded
 * everywhere. Pure — no writes.
 */
export async function resolveRecipients(
	ctx: PluginContext,
	filtersRaw: string,
	includePrimary: boolean,
): Promise<ResolvedRecipient[]> {
	const filters = parseFilters(filtersRaw);
	const primarySlug = (await getCollections(ctx))[0].toLowerCase();
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
		const source = typeof data._collection === "string" ? data._collection : "import";
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

/** A few real addresses for the preview's merge-tag sample picker. */
export async function sampleSubscribers(ctx: PluginContext, limit = 25): Promise<string[]> {
	try {
		return (await listAllSubscribers(ctx))
			.filter((e) => e.data.subscription === "confirmed" && !e.data.blocked)
			.slice(0, limit)
			.map((e) => e.data.email);
	} catch {
		return [];
	}
}

export { contentApi };
