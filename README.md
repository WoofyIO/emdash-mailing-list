# emdash-mailing-list

A *very* simple mailing list for [EmDash CMS](https://docs.emdashcms.com): signup with double opt-in, one-click unsubscribe, admin-composed **Markdown** blasts in a **branded HTML template**, per-blast delivery status, and automatic bounce handling via [Postal](https://postalserver.io) webhooks.

Email is delivered through whatever email provider the site already has configured (e.g. [emdash-postal](https://github.com/undefined-charity/emdash-postal)) — this plugin adds the list, not the transport.

## How subscribers are stored

**Subscribers are regular CMS content entries** in a `subscribers` collection — browse and edit them under **Content**, and extend the schema with your own fields (`is_wine_club_member`, `first_name`, …) in the admin schema editor. Every field is available as a `{{merge_tag}}` in blast subjects and bodies.

Minimum fields (see the seed snippet below): `email` (string), `subscription` (string: `pending`/`confirmed`/`unsubscribed`), `blocked` (boolean), `token` (string), `soft_fails` (integer), `bounce_reason` (string), `source` (string).

### Multiple source collections

The **Source collections** setting takes a comma-separated list. The first is the *primary* list (where signups, tokens, and suppression live). Extra collections — for example an `attendees` collection on an events site — only need an `email` field:

- Blasts go to primary sendable subscribers **plus** everyone in the extra collections.
- Extra-source recipients are auto-materialized into the primary list on their first blast (with a real unsubscribe token, `source` set to `import`).
- Unsubscribed/blocked addresses in the primary list are **never** emailed, regardless of which source they appear in.
- Extra-collection fields (attendee name, ticket type, …) work as merge tags in emails to those recipients.

## Features

- **Signup** — public JSON endpoint with an email-format check and honeypot; safe to call from any site form
- **Double opt-in** — subscribers confirm via an emailed link before receiving blasts
- **Unsubscribe** — tokenized one-click link appended to every blast automatically
- **Blasts** — Markdown compose (`**bold**`, `*italic*`, `[links](…)`, `#` headings, `-` lists), `{{merge_tags}}`, queued and sent in rate-limited batches with live sent/delivered/failed/bounced counts
- **HTML template** — paste your site's email shell in settings; `{{content}}` receives the rendered message (also available: `{{subject}}`, `{{unsubscribe_url}}`, `{{list_name}}`). Leave empty for a clean default.
- **Subscriber management** — per-row **Confirm / Block / Unblock / Delete** actions in the admin, plus manual add
- **Bounce handling** — Postal webhook: hard bounces **block** the address (kept on the list for audit, never emailed), three soft failures do the same, `MessageSent` upgrades sends to *delivered*. Blocking is reversible with one click.

## Install

```bash
npm install github:WoofyIO/emdash-mailing-list
```

```js
// astro.config.mjs
import mailingList from "emdash-mailing-list";

emdash({
  plugins: [postal(), mailingList()],
});
```

Create the subscribers collection (seed snippet — or build it in the admin schema editor):

```json
{
  "slug": "subscribers",
  "label": "Subscribers (Mailing List)",
  "labelSingular": "Subscriber",
  "supports": [],
  "fields": [
    { "slug": "email", "label": "Email", "type": "string", "required": true },
    { "slug": "subscription", "label": "Subscription (pending / confirmed / unsubscribed)", "type": "string" },
    { "slug": "blocked", "label": "Blocked (bounced or manually suppressed)", "type": "boolean" },
    { "slug": "token", "label": "Confirm/unsubscribe token (managed by plugin)", "type": "string" },
    { "slug": "soft_fails", "label": "Soft delivery failures", "type": "integer" },
    { "slug": "bounce_reason", "label": "Bounce reason", "type": "string" },
    { "slug": "source", "label": "Source (signup / manual / ticket / import…)", "type": "string" }
  ]
}
```

Open **Admin → Mailing List** once after deploying — the first page load provisions the send-queue cron and webhook secret, and migrates any v0.1 plugin-storage subscribers into the collection.

## Wire up your site

### Signup form

POST JSON to the public endpoint. Include an empty `website` field as a bot honeypot.

```js
fetch("/_emdash/api/plugins/emdash-mailing-list/subscribe", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, website: "" }),
});
```

### Confirm / unsubscribe pages

Emails link to `/mailing/confirm?token=…` and `/mailing/unsubscribe?token=…` on your site (paths configurable via KV `settings:confirmPath` / `settings:unsubscribePath`). Add two small pages whose **client-side** script forwards the token — call the API from the browser, not from the server: a Cloudflare Worker cannot `fetch()` its own domain.

```astro
---
// src/pages/mailing/confirm.astro (unsubscribe.astro: s/confirm/unsubscribe/)
---
<h1 data-s="working">Confirming…</h1>
<h1 data-s="confirmed" hidden>You're on the list!</h1>
<h1 data-s="failed" hidden>That link didn't work.</h1>
<script is:inline>
  const token = new URLSearchParams(location.search).get("token") || "";
  fetch("/_emdash/api/plugins/emdash-mailing-list/confirm?token=" + encodeURIComponent(token))
    .then((r) => r.json())
    .then((j) => {
      const ok = j?.data?.state === "confirmed";
      document.querySelectorAll("[data-s]").forEach((el) => (el.hidden = el.dataset.s !== (ok ? "confirmed" : "failed")));
    });
</script>
```

### Postal bounce webhook

The admin page shows your webhook URL (it embeds a generated secret — treat the URL as a credential):

```
https://your-site.com/_emdash/api/plugins/emdash-mailing-list/webhook?key=<secret>
```

In Postal: **Server → Webhooks → Add webhook**, paste the URL, select the events `MessageSent`, `MessageDeliveryFailed`, `MessageBounced`, `MessageHeld`.

## Notes & limits

- Batch size defaults to 25 sends/minute (configurable 1–100) to stay friendly to Workers subrequest limits and your mail server.
- Subscribers live in your site's own database and ride along with your existing backups.
- Bounce correlation is by recipient address (most recent send) — exact for single-list setups.
- No segmentation or scheduling (yet) — it's the *very simple* mailing list.

## Development

```bash
npm install
npm run build      # tsdown → dist/ (committed, so GitHub installs need no build step)
npm run typecheck
```

MIT © Woofy
