/**
 * Turning a blast into an email.
 *
 * A blast body is either Portable Text (composed in the admin's rich-text
 * editor) or Markdown (older blasts, scripted callers). Both render to an HTML
 * fragment and a plain-text alternative, which are dropped into the site's
 * HTML template with merge tags filled from the recipient's record.
 *
 * Email clients are a hostile rendering target: no external CSS, patchy
 * flexbox, images blocked by default. So the Portable Text renderer emits
 * inline-styled, table-free markup and absolute image URLs, and anything it
 * doesn't know how to render (columns, embeds, galleries) is dropped rather
 * than emitted as something a client might mangle.
 */
import { toHTML, uriLooksSafe, type PortableTextHtmlComponents } from "@portabletext/to-html";
import type { PluginContext } from "emdash";

import { getListName, getOrigin, getTemplate, pagePath } from "./settings.js";
import type { SubscriberData } from "./subscribers.js";
import { gatherExtraData } from "./targeting.js";

export type PortableTextBlocks = Array<Record<string, unknown>>;

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Markdown (legacy bodies) ─────────────────────────────────────────────────

/** Tiny Markdown subset: #/##/### headings, -/* lists, ---, **bold**, *italic*, [text](url). */
export function markdownToHtml(md: string): string {
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

export function markdownToText(md: string): string {
	return md
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/^#{1,3}\s+/gm, "");
}

// ─── Portable Text ────────────────────────────────────────────────────────────

const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";

/** Absolute URL for an image asset — mail clients can't resolve site-relative paths. */
function imageUrl(asset: Record<string, unknown> | undefined, origin: string): string | null {
	if (!asset) return null;
	const url = typeof asset.url === "string" ? asset.url : "";
	if (/^https?:\/\//.test(url)) return url;
	if (url.startsWith("/")) return origin ? `${origin}${url}` : url;
	const ref = typeof asset._ref === "string" ? asset._ref : "";
	if (ref && /^[A-Za-z0-9._/-]+$/.test(ref)) return `${origin}${INTERNAL_MEDIA_PREFIX}${ref}`;
	return null;
}

const attr = (v: unknown) => escapeHtml(String(v ?? ""));

function emailComponents(origin: string): Partial<PortableTextHtmlComponents> {
	const button = (b: Record<string, unknown>): string => {
		const text = attr(b.text);
		const href = typeof b.url === "string" && uriLooksSafe(b.url) ? b.url : "";
		const fill = b.style === "fill" || b.style === "default";
		const style = fill
			? "display:inline-block;padding:12px 22px;border-radius:999px;background:#ff00d2;color:#ffffff;text-decoration:none;font-weight:600"
			: "display:inline-block;padding:12px 22px;border-radius:999px;border:1px solid #ff00d2;color:#ff00d2;text-decoration:none;font-weight:600";
		return href ? `<a href="${attr(href)}" style="${style}">${text}</a>` : `<span style="${style}">${text}</span>`;
	};

	return {
		block: {
			normal: ({ children }) => `<p style="margin:0 0 16px">${children}</p>`,
			h1: ({ children }) => `<h1 style="margin:24px 0 12px;font-size:28px;line-height:1.2">${children}</h1>`,
			h2: ({ children }) => `<h2 style="margin:24px 0 12px;font-size:22px;line-height:1.25">${children}</h2>`,
			h3: ({ children }) => `<h3 style="margin:20px 0 8px;font-size:18px;line-height:1.3">${children}</h3>`,
			h4: ({ children }) => `<h4 style="margin:16px 0 8px;font-size:16px">${children}</h4>`,
			blockquote: ({ children }) =>
				`<blockquote style="margin:16px 0;padding:8px 16px;border-left:3px solid #ff00d2;opacity:.85">${children}</blockquote>`,
		},
		list: {
			bullet: ({ children }) => `<ul style="margin:0 0 16px;padding-left:24px">${children}</ul>`,
			number: ({ children }) => `<ol style="margin:0 0 16px;padding-left:24px">${children}</ol>`,
		},
		listItem: ({ children }) => `<li style="margin:0 0 6px">${children}</li>`,
		marks: {
			strong: ({ children }) => `<strong>${children}</strong>`,
			em: ({ children }) => `<em>${children}</em>`,
			underline: ({ children }) => `<u>${children}</u>`,
			"strike-through": ({ children }) => `<s>${children}</s>`,
			code: ({ children }) => `<code style="font-family:monospace;background:#f2f2f2;padding:1px 4px">${children}</code>`,
			link: ({ children, value }) => {
				const href = typeof value?.href === "string" && uriLooksSafe(value.href) ? value.href : "";
				return href ? `<a href="${attr(href)}" style="color:#ff00d2">${children}</a>` : children;
			},
		},
		types: {
			image: ({ value }) => {
				const v = value as Record<string, unknown>;
				const src = imageUrl(v.asset as Record<string, unknown> | undefined, origin);
				if (!src) return "";
				const width = typeof v.displayWidth === "number" ? v.displayWidth : typeof v.width === "number" ? v.width : null;
				const widthAttr = width ? ` width="${Math.min(width, 600)}"` : "";
				const caption = typeof v.caption === "string" && v.caption ? `<p style="margin:6px 0 16px;font-size:13px;color:#777">${attr(v.caption)}</p>` : "";
				return `<img src="${attr(src)}" alt="${attr(v.alt)}"${widthAttr} style="display:block;max-width:100%;height:auto;margin:16px 0">${caption}`;
			},
			buttons: ({ value }) => {
				const v = value as { buttons?: Array<Record<string, unknown>> };
				const items = (v.buttons ?? []).filter((b) => typeof b.text === "string" && b.text);
				return items.length ? `<p style="margin:20px 0">${items.map(button).join(" &nbsp; ")}</p>` : "";
			},
			button: ({ value }) => `<p style="margin:20px 0">${button(value as Record<string, unknown>)}</p>`,
			break: ({ value }) => {
				const style = (value as { style?: string }).style;
				if (style === "space") return `<div style="height:24px"></div>`;
				return `<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">`;
			},
			pullquote: ({ value }) => {
				const v = value as { text?: string; citation?: string };
				const cite = v.citation ? `<footer style="font-size:13px;color:#777;margin-top:4px">— ${attr(v.citation)}</footer>` : "";
				return `<blockquote style="margin:20px 0;padding:0 16px;border-left:3px solid #ff00d2;font-size:18px;font-style:italic">${attr(v.text)}${cite}</blockquote>`;
			},
			code: ({ value }) =>
				`<pre style="margin:16px 0;padding:12px;background:#f2f2f2;overflow:auto;font-size:13px"><code>${attr((value as { code?: string }).code)}</code></pre>`,
		},
		// Columns, galleries, embeds, tables and any plugin block: dropped rather
		// than rendered into something a mail client would mangle.
		unknownType: () => "",
		unknownMark: ({ children }) => children,
		unknownBlockStyle: ({ children }) => `<p style="margin:0 0 16px">${children}</p>`,
		unknownList: ({ children }) => `<ul style="margin:0 0 16px;padding-left:24px">${children}</ul>`,
		unknownListItem: ({ children }) => `<li>${children}</li>`,
	};
}

export function portableTextToHtml(blocks: PortableTextBlocks, origin: string): string {
	if (!Array.isArray(blocks) || blocks.length === 0) return "";
	return toHTML(blocks as never, { components: emailComponents(origin), onMissingComponent: false });
}

/** Plain-text alternative: headings, paragraphs, lists, links with their URLs, buttons as "Label: url". */
export function portableTextToText(blocks: PortableTextBlocks): string {
	if (!Array.isArray(blocks)) return "";
	const lines: string[] = [];
	for (const block of blocks) {
		const type = block._type;
		if (type === "block") {
			const markDefs = (block.markDefs as Array<Record<string, unknown>> | undefined) ?? [];
			const text = ((block.children as Array<Record<string, unknown>> | undefined) ?? [])
				.map((child) => {
					const t = typeof child.text === "string" ? child.text : "";
					const marks = (child.marks as string[] | undefined) ?? [];
					const link = markDefs.find((d) => marks.includes(String(d._key)) && d._type === "link");
					return link && typeof link.href === "string" ? `${t} (${link.href})` : t;
				})
				.join("");
			if (!text.trim()) continue;
			const prefix = block.listItem === "bullet" ? "- " : block.listItem === "number" ? "1. " : "";
			lines.push(prefix + text);
			if (!block.listItem) lines.push("");
		} else if (type === "buttons") {
			for (const b of (block.buttons as Array<Record<string, unknown>> | undefined) ?? []) {
				if (typeof b.text === "string") lines.push(typeof b.url === "string" ? `${b.text}: ${b.url}` : b.text);
			}
			lines.push("");
		} else if (type === "button") {
			if (typeof block.text === "string") lines.push(typeof block.url === "string" ? `${block.text}: ${block.url}` : block.text, "");
		} else if (type === "pullquote") {
			lines.push(`"${String(block.text ?? "")}"`, "");
		} else if (type === "image") {
			if (typeof block.alt === "string" && block.alt) lines.push(`[${block.alt}]`, "");
		} else if (type === "break") {
			lines.push("");
		} else if (type === "code") {
			lines.push(String(block.code ?? ""), "");
		}
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Merge tags + template ────────────────────────────────────────────────────

/** Replace {{field}} merge tags from subscriber data (missing fields → ""). HTML-escaped when `html`. */
export function mergeTags(text: string, data: Record<string, unknown>, html = false): string {
	return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
		const value = data[key];
		if (value === undefined || value === null) return "";
		const str = typeof value === "string" ? value : String(value);
		return html ? escapeHtml(str) : str;
	});
}

export const DEFAULT_TEMPLATE = `<!doctype html>
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

export interface BlastContent {
	subject: string;
	/** Markdown body (legacy / scripted). */
	body?: string;
	/** Portable Text body (composed in the admin). Wins over `body` when present. */
	bodyPT?: PortableTextBlocks;
}

export interface RenderedEmail {
	subject: string;
	text: string;
	html: string;
}

/** Placeholder recipient for previews when the list is empty. */
export function placeholderSubscriber(): SubscriberData {
	return { email: "someone@example.com", subscription: "confirmed", blocked: false, token: "preview", soft_fails: 0 };
}

export async function renderEmail(
	ctx: PluginContext,
	content: BlastContent,
	subscriber: SubscriberData,
): Promise<RenderedEmail> {
	const origin = await getOrigin(ctx);
	const listName = await getListName(ctx);
	const unsubscribeUrl = `${origin}${await pagePath(ctx, "unsubscribe")}?token=${subscriber.token}`;
	const template = (await getTemplate(ctx)) || DEFAULT_TEMPLATE;

	const usePT = Array.isArray(content.bodyPT) && content.bodyPT.length > 0;
	const contentHtml = usePT ? portableTextToHtml(content.bodyPT!, origin) : markdownToHtml(content.body ?? "");
	const contentText = usePT ? portableTextToText(content.bodyPT!) : markdownToText(content.body ?? "");

	const subject = mergeTags(content.subject, subscriber);
	const html = template
		.replace(/\{\{\s*content\s*\}\}/g, () => mergeTags(contentHtml, subscriber, true))
		.replace(/\{\{\s*subject\s*\}\}/g, escapeHtml(subject))
		.replace(/\{\{\s*unsubscribe_url\s*\}\}/g, unsubscribeUrl)
		.replace(/\{\{\s*list_name\s*\}\}/g, escapeHtml(listName));
	const text = `${mergeTags(contentText, subscriber)}\n\n—\nYou're receiving this because you subscribed to ${listName}.\nUnsubscribe: ${unsubscribeUrl}`;

	return { subject, text, html };
}

/**
 * The merge-tag data a real recipient would see: their primary record with
 * any extra-source fields (attendee name, ticket type…) underneath.
 */
export async function subscriberForPreview(
	ctx: PluginContext,
	entry: { data: SubscriberData } | null,
): Promise<SubscriberData> {
	if (!entry) return placeholderSubscriber();
	const extras = await gatherExtraData(ctx);
	return { ...(extras.get(entry.data.email) ?? {}), ...entry.data } as SubscriberData;
}
