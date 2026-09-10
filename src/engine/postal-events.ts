/**
 * Postal webhook events → send status, blast counters and suppression.
 *
 * Hard bounces block the address (kept on the list for audit, never emailed);
 * three consecutive soft failures do the same. Opens and clicks are counted
 * once per recipient, and a click implies an open since pixel blocking is
 * common.
 */
import type { PluginContext } from "emdash";

import { blasts, sendsStore, type Send } from "./queue.js";
import { normalizeEmail, now } from "./settings.js";
import { findByEmail, upsertSubscriber } from "./subscribers.js";

export async function handlePostalEvent(
	ctx: PluginContext,
	event: string,
	payload: Record<string, unknown>,
): Promise<string> {
	// DomainDNSError is server-scoped, not tied to a recipient.
	if (event === "DomainDNSError") {
		const domain = String(payload?.domain ?? "unknown");
		ctx.log.error(`Postal reports a DNS problem for ${domain}`, payload);
		return `dns error recorded: ${domain}`;
	}

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

	const markEngagement = async (kind: "opened" | "clicked") => {
		if (!sendRow) return false;
		const stamp = kind === "opened" ? "openedAt" : "clickedAt";
		if (sendRow.data[stamp]) return false;
		await sendsStore(ctx).put(sendRow.id, { ...sendRow.data, [stamp]: now() });
		const blast = await blasts(ctx).get(sendRow.data.blastId);
		if (blast) {
			blast[kind] = (blast[kind] ?? 0) + 1;
			await blasts(ctx).put(sendRow.data.blastId, blast);
		}
		return true;
	};

	const bumpBlast = async (field: "delayed" | "held") => {
		if (!sendRow) return;
		const blast = await blasts(ctx).get(sendRow.data.blastId);
		if (!blast) return;
		blast[field] = (blast[field] ?? 0) + 1;
		await blasts(ctx).put(sendRow.data.blastId, blast);
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

		case "MessageLoaded": {
			const first = await markEngagement("opened");
			return first ? `opened: ${email}` : `opened again (not recounted): ${email}`;
		}

		case "MessageLinkClicked": {
			await markEngagement("opened");
			const first = await markEngagement("clicked");
			return first ? `clicked: ${email}` : `clicked again (not recounted): ${email}`;
		}

		case "MessageDelayed":
			await bumpBlast("delayed");
			await applySendStatus("delayed", String(payload?.details ?? "delayed, will retry").slice(0, 200));
			return `delayed (will retry): ${email}`;

		case "MessageBounced":
			await applySendStatus("bounced", "bounced");
			await block("bounce received");
			return `bounced (blocked): ${email}`;

		case "MessageDeliveryFailed":
		case "MessageHeld": {
			const status = String(payload?.status ?? "");
			if (status === "HardFail") {
				await applySendStatus("bounced", "hard delivery failure");
				await block(`HardFail: ${String(payload?.details ?? "").slice(0, 200)}`);
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
