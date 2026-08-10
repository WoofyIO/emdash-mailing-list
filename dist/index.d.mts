import { PluginDescriptor } from "emdash";

//#region src/index.d.ts
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
declare function emdashMailingList(): PluginDescriptor;
//#endregion
export { emdashMailingList as default, emdashMailingList };