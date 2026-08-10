import { definePlugin } from "emdash";
//#region src/sandbox-entry.ts
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function now() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function randomToken() {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function normalizeEmail(value) {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	return EMAIL_RE.test(email) ? email : null;
}
async function rememberOrigin(ctx, request) {
	try {
		const origin = new URL(request.url).origin;
		if (await ctx.kv.get("state:origin") !== origin) await ctx.kv.set("state:origin", origin);
	} catch {}
}
async function getOrigin(ctx) {
	return await ctx.kv.get("state:origin") ?? "";
}
function routeUrl(origin, route, params) {
	return `${origin}/_emdash/api/plugins/emdash-mailing-list/${route}?${new URLSearchParams(params).toString()}`;
}
async function ensureCron(ctx) {
	try {
		if (!(await ctx.cron?.list())?.some((t) => (t.name ?? t.taskName) === "process-queue")) {
			await ctx.cron?.schedule("process-queue", { schedule: "* * * * *" });
			ctx.log.info("Mailing list send queue scheduled");
		}
	} catch (error) {
		ctx.log.error("Failed to schedule send queue", error);
	}
}
async function getWebhookSecret(ctx) {
	let secret = await ctx.kv.get("state:webhookSecret");
	if (!secret) {
		secret = randomToken();
		await ctx.kv.set("state:webhookSecret", secret);
	}
	return secret;
}
async function getListName(ctx) {
	return await ctx.kv.get("settings:listName") ?? "our mailing list";
}
async function pagePath(ctx, kind) {
	const key = kind === "confirm" ? "settings:confirmPath" : "settings:unsubscribePath";
	return await ctx.kv.get(key) ?? `/mailing/${kind}`;
}
function subscribers(ctx) {
	return ctx.storage.subscribers;
}
function blasts(ctx) {
	return ctx.storage.blasts;
}
function sendsStore(ctx) {
	return ctx.storage.sends;
}
function withFooter(body, listName, unsubscribeUrl) {
	return {
		text: `${body}\n\n—\nYou're receiving this because you subscribed to ${listName}.\nUnsubscribe: ${unsubscribeUrl}`,
		html: `${body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n")}\n<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">\n<p style="font-size:12px;color:#777">You're receiving this because you subscribed to ${escapeHtml(listName)}. <a href="${unsubscribeUrl}">Unsubscribe</a></p>`
	};
}
function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function sendConfirmationEmail(ctx, sub) {
	if (!ctx.email) throw new Error("No email provider is configured");
	const origin = await getOrigin(ctx);
	const listName = await getListName(ctx);
	const confirmUrl = `${origin}${await pagePath(ctx, "confirm")}?token=${sub.token}`;
	await ctx.email.send({
		to: sub.email,
		subject: `Confirm your subscription to ${listName}`,
		text: `Hi!\n\nSomeone (hopefully you) asked to join ${listName}.\n\nConfirm your subscription:\n${confirmUrl}\n\nIf this wasn't you, ignore this email and you won't hear from us again.`,
		html: `<p>Hi!</p><p>Someone (hopefully you) asked to join ${escapeHtml(listName)}.</p><p><a href="${confirmUrl}">Confirm your subscription</a></p><p style="font-size:12px;color:#777">If this wasn't you, ignore this email and you won't hear from us again.</p>`
	});
}
async function processQueue(ctx) {
	const batchSize = await ctx.kv.get("settings:batchSize") ?? 25;
	const queued = await sendsStore(ctx).query({
		where: { status: "queued" },
		limit: Math.max(1, Math.min(batchSize, 100))
	});
	if (queued.items.length === 0) return;
	if (!ctx.email) {
		ctx.log.error("Mailing list: queued sends but no email provider configured");
		return;
	}
	const origin = await getOrigin(ctx);
	const listName = await getListName(ctx);
	const unsubPath = await pagePath(ctx, "unsubscribe");
	const blastCache = /* @__PURE__ */ new Map();
	const touchedBlasts = /* @__PURE__ */ new Set();
	for (const { id, data: send } of queued.items) {
		let blast = blastCache.get(send.blastId) ?? await blasts(ctx).get(send.blastId);
		if (!blast) {
			await sendsStore(ctx).put(id, {
				...send,
				status: "failed",
				error: "blast missing"
			});
			continue;
		}
		blastCache.set(send.blastId, blast);
		touchedBlasts.add(send.blastId);
		const sub = await subscribers(ctx).get(send.email);
		if (!sub || sub.status !== "confirmed") {
			await sendsStore(ctx).put(id, {
				...send,
				status: "failed",
				error: "not subscribed"
			});
			blast.failed += 1;
			continue;
		}
		const unsubscribeUrl = `${origin}${unsubPath}?token=${sub.token}`;
		const { text, html } = withFooter(blast.body, listName, unsubscribeUrl);
		try {
			await ctx.email.send({
				to: send.email,
				subject: blast.subject,
				text,
				html
			});
			await sendsStore(ctx).put(id, {
				...send,
				status: "sent",
				sentAt: now()
			});
			blast.sent += 1;
		} catch (error) {
			await sendsStore(ctx).put(id, {
				...send,
				status: "failed",
				error: error instanceof Error ? error.message.slice(0, 300) : String(error)
			});
			blast.failed += 1;
		}
	}
	for (const blastId of touchedBlasts) {
		const blast = blastCache.get(blastId);
		if (await sendsStore(ctx).count({
			blastId,
			status: "queued"
		}) === 0 && blast.status === "sending") {
			blast.status = "sent";
			blast.completedAt = now();
		}
		await blasts(ctx).put(blastId, blast);
	}
}
async function enqueueBlast(ctx, subject, body) {
	const blastId = `blast_${Date.now()}_${randomToken().slice(0, 6)}`;
	let total = 0;
	let cursor;
	do {
		const page = await subscribers(ctx).query({
			where: { status: "confirmed" },
			limit: 100,
			cursor
		});
		if (page.items.length > 0) {
			await sendsStore(ctx).putMany(page.items.map(({ data: sub }) => ({
				id: `${blastId}:${sub.email}`,
				data: {
					blastId,
					email: sub.email,
					status: "queued",
					createdAt: now()
				}
			})));
			total += page.items.length;
		}
		cursor = page.cursor && page.hasMore ? page.cursor : void 0;
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
		createdAt: now()
	});
	return {
		blastId,
		total
	};
}
/**
* Postal webhook payloads (Server → Webhooks). Relevant events:
* - MessageSent            — accepted by the remote server (treat as delivered)
* - MessageDeliveryFailed  — payload.status HardFail/SoftFail
* - MessageBounced         — a bounce message was received
* - MessageHeld            — held by Postal (treat as soft failure)
*/
async function handlePostalEvent(ctx, event, payload) {
	const email = normalizeEmail((payload?.message ?? payload?.original_message ?? payload)?.to);
	if (!email) return "ignored: no recipient";
	const sub = await subscribers(ctx).get(email);
	const sendRow = (await sendsStore(ctx).query({
		where: { email },
		limit: 100
	})).items.slice().sort((a, b) => a.data.createdAt < b.data.createdAt ? 1 : -1)[0];
	const applySendStatus = async (status, error) => {
		if (!sendRow || sendRow.data.status === status) return;
		const prev = sendRow.data.status;
		await sendsStore(ctx).put(sendRow.id, {
			...sendRow.data,
			status,
			error
		});
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
		case "MessageBounced":
			await applySendStatus("bounced", "bounced");
			if (sub && sub.status !== "unsubscribed") await subscribers(ctx).put(email, {
				...sub,
				status: "bounced",
				bounceReason: "bounce received",
				unsubscribedAt: now()
			});
			return `bounced (removed from list): ${email}`;
		case "MessageDeliveryFailed":
		case "MessageHeld":
			if (String(payload?.status ?? "") === "HardFail") {
				await applySendStatus("bounced", "hard delivery failure");
				if (sub && sub.status !== "unsubscribed") await subscribers(ctx).put(email, {
					...sub,
					status: "bounced",
					bounceReason: `HardFail: ${String(payload?.details ?? "").slice(0, 200)}`,
					unsubscribedAt: now()
				});
				return `hard fail (removed from list): ${email}`;
			}
			if (sub) {
				const softFails = (sub.softFails ?? 0) + 1;
				if (softFails >= 3 && sub.status === "confirmed") {
					await applySendStatus("bounced", "3 soft failures");
					await subscribers(ctx).put(email, {
						...sub,
						softFails,
						status: "bounced",
						bounceReason: "3 consecutive soft delivery failures",
						unsubscribedAt: now()
					});
					return `soft fail #${softFails} (removed from list): ${email}`;
				}
				await subscribers(ctx).put(email, {
					...sub,
					softFails
				});
				return `soft fail #${softFails}: ${email}`;
			}
			return `soft fail (unknown subscriber): ${email}`;
		default: return `ignored: ${event}`;
	}
}
async function buildAdminPage(ctx) {
	const [confirmed, pending, unsubscribed, bounced] = await Promise.all([
		subscribers(ctx).count({ status: "confirmed" }),
		subscribers(ctx).count({ status: "pending" }),
		subscribers(ctx).count({ status: "unsubscribed" }),
		subscribers(ctx).count({ status: "bounced" })
	]);
	const recentSubs = await subscribers(ctx).query({
		orderBy: { createdAt: "desc" },
		limit: 15
	});
	const recentBlasts = await blasts(ctx).query({
		orderBy: { createdAt: "desc" },
		limit: 10
	});
	const origin = await getOrigin(ctx);
	const secret = await getWebhookSecret(ctx);
	const listName = await getListName(ctx);
	const batchSize = await ctx.kv.get("settings:batchSize") ?? 25;
	const webhookUrl = routeUrl(origin || "https://<your-site>", "webhook", { key: secret });
	const subscribeUrl = `${origin || "https://<your-site>"}/_emdash/api/plugins/emdash-mailing-list/subscribe`;
	return { blocks: [
		{
			type: "header",
			text: "Mailing List"
		},
		{
			type: "stats",
			items: [
				{
					label: "Confirmed",
					value: confirmed
				},
				{
					label: "Pending",
					value: pending
				},
				{
					label: "Unsubscribed",
					value: unsubscribed
				},
				{
					label: "Bounced",
					value: bounced
				}
			]
		},
		{
			type: "header",
			text: "Send a blast"
		},
		{
			type: "section",
			text: `Composes and queues an email to every confirmed subscriber (currently ${confirmed}). Sending happens in batches of ${batchSize} per minute; progress shows in the table below. An unsubscribe link is added automatically.`
		},
		{
			type: "form",
			block_id: "compose",
			fields: [
				{
					type: "text_input",
					action_id: "subject",
					label: "Subject"
				},
				{
					type: "text_input",
					action_id: "body",
					label: "Message (plain text; blank line = new paragraph)",
					multiline: true
				},
				{
					type: "text_input",
					action_id: "test_to",
					label: "Send a test to this address instead (leave empty to send the real blast)",
					placeholder: "you@example.com"
				}
			],
			submit: {
				label: "Send",
				action_id: "send_blast"
			}
		},
		{
			type: "header",
			text: "Blasts"
		},
		{
			type: "table",
			page_action_id: "blasts_page",
			empty_text: "No blasts sent yet.",
			columns: [
				{
					key: "subject",
					label: "Subject"
				},
				{
					key: "status",
					label: "Status"
				},
				{
					key: "progress",
					label: "Sent"
				},
				{
					key: "delivered",
					label: "Delivered"
				},
				{
					key: "failed",
					label: "Failed"
				},
				{
					key: "bounced",
					label: "Bounced"
				},
				{
					key: "createdAt",
					label: "Created",
					format: "relative_time"
				}
			],
			rows: recentBlasts.items.map(({ data: b }) => ({
				subject: b.subject,
				status: b.status,
				progress: `${b.sent}/${b.total}`,
				delivered: String(b.delivered),
				failed: String(b.failed),
				bounced: String(b.bounced),
				createdAt: b.createdAt
			}))
		},
		{
			type: "header",
			text: "Subscribers (latest 15)"
		},
		{
			type: "table",
			page_action_id: "subs_page",
			empty_text: "No subscribers yet.",
			columns: [
				{
					key: "email",
					label: "Email"
				},
				{
					key: "status",
					label: "Status"
				},
				{
					key: "createdAt",
					label: "Signed up",
					format: "relative_time"
				}
			],
			rows: recentSubs.items.map(({ data: s }) => ({
				email: s.email,
				status: s.status,
				createdAt: s.createdAt
			}))
		},
		{
			type: "form",
			block_id: "manual",
			fields: [{
				type: "text_input",
				action_id: "email",
				label: "Email address"
			}, {
				type: "select",
				action_id: "action",
				label: "Action",
				options: [{
					label: "Add as confirmed subscriber",
					value: "add"
				}, {
					label: "Unsubscribe / remove",
					value: "remove"
				}]
			}],
			submit: {
				label: "Apply",
				action_id: "manual_change"
			}
		},
		{
			type: "header",
			text: "Settings"
		},
		{
			type: "form",
			block_id: "settings",
			fields: [{
				type: "text_input",
				action_id: "listName",
				label: "List name (used in emails: “you subscribed to …”)",
				initial_value: listName
			}, {
				type: "number_input",
				action_id: "batchSize",
				label: "Sends per minute",
				min: 1,
				max: 100,
				initial_value: batchSize
			}],
			submit: {
				label: "Save Settings",
				action_id: "save_settings"
			}
		},
		{
			type: "header",
			text: "Wiring"
		},
		{
			type: "section",
			text: "Signup endpoint — POST JSON `{ \"email\": \"...\" }` from your site's form. Confirmation and unsubscribe emails link to /mailing/confirm and /mailing/unsubscribe pages on your site (see the README for copy-paste Astro pages; paths configurable via KV settings:confirmPath / settings:unsubscribePath)."
		},
		{
			type: "code",
			code: subscribeUrl,
			language: "bash"
		},
		{
			type: "section",
			text: "Bounce tracking — in Postal (Server → Webhooks) add a webhook pointing at the URL below with events MessageSent, MessageDeliveryFailed, MessageBounced, MessageHeld. Hard bounces automatically remove the address from the list; three soft failures do the same."
		},
		{
			type: "code",
			code: webhookUrl,
			language: "bash"
		}
	] };
}
var sandbox_entry_default = definePlugin({
	id: "emdash-mailing-list",
	version: "0.1.0",
	storage: {
		subscribers: { indexes: [
			"email",
			"status",
			"token",
			"createdAt"
		] },
		blasts: { indexes: ["status", "createdAt"] },
		sends: { indexes: [
			"blastId",
			"email",
			"status",
			"createdAt"
		] }
	},
	hooks: {
		"plugin:activate": { handler: async (_event, ctx) => {
			await getWebhookSecret(ctx);
			await ctx.cron.schedule("process-queue", { schedule: "* * * * *" });
			ctx.log.info("Mailing list plugin activated; send queue scheduled");
		} },
		cron: { handler: async (event, ctx) => {
			if (event.name === "process-queue") await processQueue(ctx);
		} }
	},
	routes: {
		subscribe: {
			public: true,
			handler: async (rctx, hostCtx) => {
				const ctx = hostCtx ?? rctx;
				const routeCtx = rctx;
				await rememberOrigin(ctx, routeCtx.request);
				await ensureCron(ctx);
				const input = routeCtx.input ?? {};
				if (typeof input.website === "string" && input.website.trim() !== "") return { ok: true };
				const email = normalizeEmail(input.email);
				if (!email) return {
					ok: false,
					error: "invalid_email"
				};
				const existing = await subscribers(ctx).get(email);
				if (existing?.status === "confirmed") return {
					ok: true,
					already: true
				};
				const sub = {
					email,
					status: "pending",
					token: existing?.token ?? randomToken(),
					softFails: 0,
					createdAt: existing?.createdAt ?? now()
				};
				await subscribers(ctx).put(email, sub);
				await sendConfirmationEmail(ctx, sub);
				return { ok: true };
			}
		},
		confirm: {
			public: true,
			handler: async (rctx, hostCtx) => {
				const ctx = hostCtx ?? rctx;
				const routeCtx = rctx;
				await rememberOrigin(ctx, routeCtx.request);
				const token = String(routeCtx.input?.token ?? "") || (new URL(routeCtx.request.url).searchParams.get("token") ?? "");
				if (!token) return {
					ok: false,
					state: "invalid"
				};
				const row = (await subscribers(ctx).query({
					where: { token },
					limit: 1
				})).items[0];
				if (!row) return {
					ok: false,
					state: "invalid"
				};
				await subscribers(ctx).put(row.id, {
					...row.data,
					status: "confirmed",
					softFails: 0,
					confirmedAt: now()
				});
				return {
					ok: true,
					state: "confirmed"
				};
			}
		},
		unsubscribe: {
			public: true,
			handler: async (rctx, hostCtx) => {
				const ctx = hostCtx ?? rctx;
				const routeCtx = rctx;
				await rememberOrigin(ctx, routeCtx.request);
				const token = String(routeCtx.input?.token ?? "") || (new URL(routeCtx.request.url).searchParams.get("token") ?? "");
				if (!token) return {
					ok: false,
					state: "invalid"
				};
				const row = (await subscribers(ctx).query({
					where: { token },
					limit: 1
				})).items[0];
				if (row && row.data.status !== "unsubscribed") await subscribers(ctx).put(row.id, {
					...row.data,
					status: "unsubscribed",
					unsubscribedAt: now()
				});
				return {
					ok: true,
					state: "unsubscribed"
				};
			}
		},
		webhook: {
			public: true,
			handler: async (rctx, hostCtx) => {
				const ctx = hostCtx ?? rctx;
				const routeCtx = rctx;
				const key = new URL(routeCtx.request.url).searchParams.get("key") ?? "";
				const secret = await ctx.kv.get("state:webhookSecret");
				if (!secret || key !== secret) return {
					ok: false,
					error: "unauthorized"
				};
				const body = routeCtx.input ?? {};
				const event = String(body.event ?? "");
				const result = await handlePostalEvent(ctx, event, body.payload ?? {});
				ctx.log.info(`Postal webhook: ${event} → ${result}`);
				return {
					ok: true,
					result
				};
			}
		},
		admin: { handler: async (rctx, hostCtx) => {
			const ctx = hostCtx ?? rctx;
			const routeCtx = rctx;
			await rememberOrigin(ctx, routeCtx.request);
			const interaction = routeCtx.input;
			if (interaction.type === "page_load" || interaction.type === "block_action") {
				await ensureCron(ctx);
				return buildAdminPage(ctx);
			}
			if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
				const values = interaction.values ?? {};
				if (typeof values.listName === "string" && values.listName.trim()) await ctx.kv.set("settings:listName", values.listName.trim());
				const batch = Number(values.batchSize);
				if (Number.isFinite(batch) && batch >= 1 && batch <= 100) await ctx.kv.set("settings:batchSize", Math.floor(batch));
				return {
					...await buildAdminPage(ctx),
					toast: {
						message: "Settings saved",
						type: "success"
					}
				};
			}
			if (interaction.type === "form_submit" && interaction.action_id === "manual_change") {
				const values = interaction.values ?? {};
				const email = normalizeEmail(values.email);
				if (!email) return {
					...await buildAdminPage(ctx),
					toast: {
						message: "Invalid email address",
						type: "error"
					}
				};
				const action = String(values.action ?? "add");
				const existing = await subscribers(ctx).get(email);
				if (action === "remove") {
					if (existing) await subscribers(ctx).put(email, {
						...existing,
						status: "unsubscribed",
						unsubscribedAt: now()
					});
					return {
						...await buildAdminPage(ctx),
						toast: {
							message: `${email} removed`,
							type: "success"
						}
					};
				}
				await subscribers(ctx).put(email, {
					email,
					status: "confirmed",
					token: existing?.token ?? randomToken(),
					softFails: 0,
					createdAt: existing?.createdAt ?? now(),
					confirmedAt: now()
				});
				return {
					...await buildAdminPage(ctx),
					toast: {
						message: `${email} added as confirmed`,
						type: "success"
					}
				};
			}
			if (interaction.type === "form_submit" && interaction.action_id === "send_blast") {
				const values = interaction.values ?? {};
				const subject = typeof values.subject === "string" ? values.subject.trim() : "";
				const body = typeof values.body === "string" ? values.body.trim() : "";
				const testTo = normalizeEmail(values.test_to);
				if (!subject || !body) return {
					...await buildAdminPage(ctx),
					toast: {
						message: "Subject and message are required",
						type: "error"
					}
				};
				try {
					if (testTo) {
						if (!ctx.email) throw new Error("No email provider is configured");
						const origin = await getOrigin(ctx);
						const { text, html } = withFooter(body, await getListName(ctx), `${origin}${await pagePath(ctx, "unsubscribe")}?token=test`);
						await ctx.email.send({
							to: testTo,
							subject: `[TEST] ${subject}`,
							text,
							html
						});
						return {
							...await buildAdminPage(ctx),
							toast: {
								message: `Test sent to ${testTo}`,
								type: "success"
							}
						};
					}
					await ensureCron(ctx);
					const { total } = await enqueueBlast(ctx, subject, body);
					if (total === 0) return {
						...await buildAdminPage(ctx),
						toast: {
							message: "No confirmed subscribers to send to",
							type: "error"
						}
					};
					return {
						...await buildAdminPage(ctx),
						toast: {
							message: `Blast queued to ${total} subscribers — sending starts within a minute`,
							type: "success"
						}
					};
				} catch (error) {
					return {
						...await buildAdminPage(ctx),
						toast: {
							message: `Error: ${error instanceof Error ? error.message : String(error)}`,
							type: "error"
						}
					};
				}
			}
			return { blocks: [] };
		} }
	}
});
//#endregion
export { sandbox_entry_default as default };
