/**
 * Mailing list for EmDash CMS.
 *
 * - Public signup with double opt-in, one-click unsubscribe (RFC 8058 headers)
 * - Blasts composed in the admin's rich-text editor, previewed live as the
 *   real email inside the site's template, targeted with checkboxes across
 *   the primary list and any extra source collections
 * - Rate-limited send queue; per-blast delivery, open and click reporting
 * - Postal webhook: bounces block the address, soft failures accumulate
 *
 * Native format so the admin can ship a React composer; the send engine and
 * public routes are unchanged from 0.6, and settings/storage keys are the
 * same, so an upgraded site carries on where it was.
 */
import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import { ensureCron, processOutbox, processQueue, QUEUE_TASK, STORAGE_CONFIG } from "./engine/queue.js";
import { getWebhookSecret, now } from "./engine/settings.js";
import * as r from "./routes.js";

const ID = "emdash-mailing-list";
const VERSION = "0.7.0";

const ADMIN_PAGES = [
	{ path: "/", label: "Mailing List", icon: "email" },
	{ path: "/compose", label: "Compose", icon: "edit" },
	{ path: "/subscribers", label: "Subscribers", icon: "users" },
	{ path: "/settings", label: "Settings", icon: "settings" },
];

/** Descriptor for astro.config: `emdash({ plugins: [mailingList()] })`. */
export function emdashMailingList(): PluginDescriptor {
	return {
		id: ID,
		version: VERSION,
		entrypoint: "emdash-mailing-list",
		adminEntry: "emdash-mailing-list/admin",
		options: {},
		// content:* — subscribers live in a regular CMS collection so admins can
		// browse them under Content and extend the schema with custom fields.
		capabilities: ["email:send", "content:read", "content:write"],
		storage: STORAGE_CONFIG,
		adminPages: ADMIN_PAGES,
	};
}

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: ID,
		version: VERSION,
		capabilities: ["email:send", "content:read", "content:write"],
		storage: STORAGE_CONFIG,

		hooks: {
			"plugin:activate": {
				handler: async (_event, ctx) => {
					await getWebhookSecret(ctx);
					await ensureCron(ctx);
				},
			},
			cron: {
				// A batch is up to 100 sends; each is a storage write now that the
				// transport queues, but give the hook room for a slow provider.
				timeout: 50_000,
				handler: async (event, ctx) => {
					if (event.name !== QUEUE_TASK) return;
					await ctx.kv.set("state:lastCron", now());
					await processOutbox(ctx);
					await processQueue(ctx);
				},
			},
		},

		routes: {
			// Site-facing
			subscribe: { public: true, handler: r.subscribe as never },
			confirm: { public: true, handler: r.confirm as never },
			unsubscribe: { public: true, handler: r.unsubscribe as never },
			contact: { public: true, handler: r.contact as never },
			webhook: { public: true, handler: r.webhook as never },
			health: { public: true, handler: r.health as never },

			// Admin
			overview: { handler: r.overview as never },
			"compose-options": { handler: r.composeOptions as never },
			preview: { input: r.previewInput, handler: r.preview as never },
			evaluate: { input: r.evaluateInput, handler: r.evaluate as never },
			"send-test": { input: r.sendTestInput, handler: r.sendTestRoute as never },
			send: { input: r.sendInput, handler: r.send as never },
			blasts: { handler: r.listBlasts as never },
			blast: { input: r.blastInput, handler: r.blastDetail as never },
			subscribers: { input: r.subscriberListInput, handler: r.listSubscribers as never },
			"subscriber-action": { input: r.subscriberActionInput, handler: r.subscriberAction as never },
			"settings-get": { handler: r.settingsGet as never },
			"settings-save": { input: r.settingsInput, handler: r.settingsSave as never },
		},

		admin: { pages: ADMIN_PAGES },
	});
}

// Default export stays the descriptor factory so `import mailingList from
// "emdash-mailing-list"` keeps working; EmDash imports `createPlugin` by name.
export default emdashMailingList;
