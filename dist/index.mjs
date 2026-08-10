//#region src/index.ts
/**
* A very simple mailing list for EmDash CMS.
*
* - Public signup route with double opt-in (confirmation email)
* - One-click unsubscribe links in every send
* - Admin page (Block Kit): subscriber counts, compose & send blasts,
*   per-blast delivery status
* - Postal webhook endpoint: delivery/bounce events update send status and
*   automatically remove hard-bouncing addresses from the list
*
* Email goes out through the site's configured email provider (e.g. the
* emdash-postal plugin), so there is no transport configuration here.
*/
function emdashMailingList() {
	return {
		id: "emdash-mailing-list",
		version: "0.2.0",
		format: "standard",
		entrypoint: "emdash-mailing-list/sandbox",
		options: {},
		capabilities: [
			"email:send",
			"content:read",
			"content:write"
		],
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
		adminPages: [{
			path: "/mailing-list",
			label: "Mailing List",
			icon: "email"
		}]
	};
}
//#endregion
export { emdashMailingList as default, emdashMailingList };
