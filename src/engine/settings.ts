/**
 * Settings and per-site state, all in the plugin's scoped KV.
 *
 * Keys are unchanged from the sandboxed 0.x plugin so an upgraded site keeps
 * its list name, sources, template and webhook secret without a migration:
 *
 *   settings:listName, settings:batchSize, settings:contactTo,
 *   settings:collections, settings:groupFields, settings:template,
 *   settings:confirmPath, settings:unsubscribePath
 *   state:origin, state:webhookSecret, state:lastCron
 */
import type { PluginContext } from "emdash";

export const DEFAULT_LIST_NAME = "our mailing list";
export const DEFAULT_BATCH_SIZE = 25;
export const DEFAULT_CONFIRM_PATH = "/mailing/confirm";
export const DEFAULT_UNSUBSCRIBE_PATH = "/mailing/unsubscribe";

export interface Settings {
	listName: string;
	batchSize: number;
	contactTo: string;
	/** Source collections; the first is the primary list. */
	collections: string[];
	/** collection → field whose distinct values become targeting checkboxes. */
	groupFields: Record<string, string>;
	/** HTML shell; empty means the built-in default. */
	template: string;
	confirmPath: string;
	unsubscribePath: string;
}

export function now(): string {
	return new Date().toISOString();
}

export function randomToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	return EMAIL_RE.test(email) ? email : null;
}

/** Remember the public origin so emailed links point at the real site. */
export async function rememberOrigin(ctx: PluginContext, request: Request): Promise<void> {
	try {
		const origin = new URL(request.url).origin;
		const known = await ctx.kv.get<string>("state:origin");
		if (known !== origin) await ctx.kv.set("state:origin", origin);
	} catch {
		/* non-fatal */
	}
}

export async function getOrigin(ctx: PluginContext): Promise<string> {
	return (await ctx.kv.get<string>("state:origin")) ?? "";
}

export async function getWebhookSecret(ctx: PluginContext): Promise<string> {
	let secret = await ctx.kv.get<string>("state:webhookSecret");
	if (!secret) {
		secret = randomToken();
		await ctx.kv.set("state:webhookSecret", secret);
	}
	return secret;
}

export async function getListName(ctx: PluginContext): Promise<string> {
	return (await ctx.kv.get<string>("settings:listName")) ?? DEFAULT_LIST_NAME;
}

export async function getBatchSize(ctx: PluginContext): Promise<number> {
	const raw = await ctx.kv.get<number>("settings:batchSize");
	return typeof raw === "number" && raw >= 1 ? Math.min(Math.floor(raw), 100) : DEFAULT_BATCH_SIZE;
}

/** Source collections; first is the primary list where signups and suppression live. */
export async function getCollections(ctx: PluginContext): Promise<string[]> {
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

export async function getCollection(ctx: PluginContext): Promise<string> {
	return (await getCollections(ctx))[0];
}

/** Parse "attendees:event, waitlist:event" into a map. */
export function parseGroupFields(raw: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const part of raw.split(",")) {
		const m = part.match(/^\s*([a-z][a-z0-9_]*)\s*:\s*([a-zA-Z0-9_]+)\s*$/i);
		if (m) map.set(m[1].toLowerCase(), m[2]);
	}
	return map;
}

export async function getGroupFields(ctx: PluginContext): Promise<Map<string, string>> {
	return parseGroupFields((await ctx.kv.get<string>("settings:groupFields")) ?? "");
}

export async function getTemplate(ctx: PluginContext): Promise<string> {
	return (await ctx.kv.get<string>("settings:template")) ?? "";
}

export async function pagePath(ctx: PluginContext, kind: "confirm" | "unsubscribe"): Promise<string> {
	const key = kind === "confirm" ? "settings:confirmPath" : "settings:unsubscribePath";
	const fallback = kind === "confirm" ? DEFAULT_CONFIRM_PATH : DEFAULT_UNSUBSCRIBE_PATH;
	return (await ctx.kv.get<string>(key)) ?? fallback;
}

export async function getSettings(ctx: PluginContext): Promise<Settings> {
	const [listName, batchSize, contactTo, collections, groupFieldsRaw, template, confirmPath, unsubscribePath] =
		await Promise.all([
			getListName(ctx),
			getBatchSize(ctx),
			ctx.kv.get<string>("settings:contactTo"),
			getCollections(ctx),
			ctx.kv.get<string>("settings:groupFields"),
			getTemplate(ctx),
			pagePath(ctx, "confirm"),
			pagePath(ctx, "unsubscribe"),
		]);
	return {
		listName,
		batchSize,
		contactTo: contactTo ?? "",
		collections,
		groupFields: Object.fromEntries(parseGroupFields(groupFieldsRaw ?? "")),
		template,
		confirmPath,
		unsubscribePath,
	};
}

export interface SettingsPatch {
	listName?: string;
	batchSize?: number;
	contactTo?: string;
	collections?: string;
	groupFields?: string;
	template?: string;
	confirmPath?: string;
	unsubscribePath?: string;
}

/** Validate and store; returns the first problem found, or null. */
export async function saveSettings(ctx: PluginContext, patch: SettingsPatch): Promise<string | null> {
	if (patch.listName !== undefined) {
		const v = patch.listName.trim();
		if (!v) return "List name can't be empty";
		await ctx.kv.set("settings:listName", v);
	}
	if (patch.batchSize !== undefined) {
		if (!Number.isFinite(patch.batchSize) || patch.batchSize < 1 || patch.batchSize > 100) {
			return "Sends per minute must be between 1 and 100";
		}
		await ctx.kv.set("settings:batchSize", Math.floor(patch.batchSize));
	}
	if (patch.contactTo !== undefined) {
		const v = patch.contactTo.trim();
		if (v && !normalizeEmail(v)) return "Contact recipient must be an email address";
		await ctx.kv.set("settings:contactTo", v);
	}
	if (patch.collections !== undefined) {
		const slugs = patch.collections
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (slugs.length === 0) return "At least one source collection is required";
		if (slugs.some((s) => !/^[a-z][a-z0-9_]*$/i.test(s))) return "Collection slugs may only contain letters, digits and underscores";
		await ctx.kv.set("settings:collections", slugs.join(", "));
	}
	if (patch.groupFields !== undefined) {
		const raw = patch.groupFields.trim();
		const parts = raw ? raw.split(",").map((p) => p.trim()).filter(Boolean) : [];
		if (parts.some((p) => !/^[a-z][a-z0-9_]*:[a-zA-Z0-9_]+$/i.test(p))) {
			return "Checkbox targeting must be collection:field pairs, e.g. attendees:event";
		}
		await ctx.kv.set("settings:groupFields", raw);
	}
	if (patch.template !== undefined) {
		await ctx.kv.set("settings:template", patch.template.trim());
	}
	for (const [key, kv] of [
		["confirmPath", "settings:confirmPath"],
		["unsubscribePath", "settings:unsubscribePath"],
	] as const) {
		const value = patch[key];
		if (value === undefined) continue;
		const v = value.trim();
		if (!v.startsWith("/")) return `${key === "confirmPath" ? "Confirm" : "Unsubscribe"} page path must start with /`;
		await ctx.kv.set(kv, v);
	}
	return null;
}
