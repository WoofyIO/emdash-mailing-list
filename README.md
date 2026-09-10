# emdash-mailing-list

A simple mailing list for [EmDash CMS](https://docs.emdashcms.com): signup with double opt-in, one-click unsubscribe, blasts composed in the admin's **rich-text editor** with a **live preview of the real email** in your branded HTML template, checkbox targeting across collections, per-blast delivery/open/click reporting, and automatic bounce handling via [Postal](https://postalserver.io) webhooks.

Version 0.7 is a *native* EmDash plugin (React admin pages, no sandbox) — see [Upgrading from 0.6](#upgrading-from-06).

Email is delivered through whatever email provider the site already has configured (e.g. [emdash-postal](https://github.com/undefined-charity/emdash-postal)) — this plugin adds the list, not the transport.

## How subscribers are stored

**Subscribers are regular CMS content entries** in a `subscribers` collection — browse and edit them under **Content**, and extend the schema with your own fields (`is_wine_club_member`, `first_name`, …) in the admin schema editor. Every field is available as a `{{merge_tag}}` in blast subjects and bodies.

Minimum fields (see the seed snippet below): `email` (string), `title` (string — maintained by the plugin as `email — state` for a readable content list), `subscription` (string: `pending`/`confirmed`/`unsubscribed`), `blocked` (boolean), `token` (string), `soft_fails` (integer), `bounce_reason` (string), `source` (string).

> Entry draft/published status can't be set through the plugin content API (system columns are protected), so the plugin ignores it — `subscription` is the source of truth, mirrored into the title.

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
- **Compose** — the same Portable Text editor as the rest of the admin: headings, lists, links, bold/italic, images from the media library, button blocks, dividers, pull quotes. `{{merge_tags}}` in subject and body. Blocks email clients can't render (columns, embeds, galleries) are dropped, never mangled.
- **Live preview** — rendered server-side on every keystroke, as HTML (in an isolated iframe) or plain text, inside your saved template, with merge tags filled from a subscriber you pick — what you see is byte-for-byte what goes out
- **Blasts** — queued and sent in rate-limited batches with live sent/delivered/failed/bounced counts. Markdown bodies are still accepted from scripted callers.
- **Targeting** — **checkboxes, not syntax**: one per source collection, plus one per value of that collection's group field (set **Checkbox targeting** to e.g. `attendees:event` and every event becomes a tickbox with a recipient count). Untick a source to exclude it entirely. An **Advanced filter** box still accepts the raw `attendees: year=2026, void=false` syntax and is ANDed on top, and **Evaluate** mode shows exactly who would receive the blast (email, source, state) without sending anything.

  Ticking a subset of the group values ORs them, so "everyone who came to the first event but not the second" is two clicks. Filters for the same field are ORed; different fields are ANDed.
- **HTML template** — paste your site's email shell in settings, with a live preview of the saved template beside it; `{{content}}` receives the rendered message (also available: `{{subject}}`, `{{unsubscribe_url}}`, `{{list_name}}`). Leave empty for a clean default. Don't put `{{content}}` in an HTML comment — it's replaced everywhere it appears.
- **Subscriber management** — per-row **Confirm / Block / Unblock / Delete** actions in the admin, plus manual add
- **Per-blast reporting** — delivered, unique opens and clicks (with rates against delivered), failures, bounces and delayed counts, per blast in the admin. Opens and clicks are de-duplicated per recipient, and a click also counts as an open since pixel blocking is common.
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

### Postal webhook events

Point Postal's webhook at the plugin and enable **all** events — the plugin uses
each one:

| Event | Effect |
| --- | --- |
| `MessageSent` | send marked *delivered* |
| `MessageLoaded` | unique open |
| `MessageLinkClicked` | unique click (also counts as an open) |
| `MessageDelayed` | recorded, will retry — no suppression |
| `MessageDeliveryFailed` / `MessageHeld` | hard fail blocks; soft fails block after three |
| `MessageBounced` | blocks the address |
| `DomainDNSError` | logged against the domain |

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

## Uptime monitoring

A public watchdog endpoint reports deep health — a real database read, the email provider, the send-queue cron heartbeat, and whether queued sends are stuck:

```
GET /_emdash/api/plugins/emdash-mailing-list/health
→ {"success":true,"data":{"status":"healthy","checks":{"database":"up","email_provider":"configured","cron_age_seconds":42,"cron":"beating","queued_sends":0}}}
```

`status` is `"healthy"` only when every check passes (`"degraded"` otherwise, including when the cron hasn't ticked in 5 minutes — the failure mode that silently stalls blasts). Point a keyword monitor (UptimeRobot, etc.) at the URL and alert when the response **doesn't** contain `healthy`.

## Notes & limits

- Batch size defaults to 25 sends/minute (configurable 1–100) to stay friendly to Workers subrequest limits and your mail server.
- Subscribers live in your site's own database and ride along with your existing backups.
- Bounce correlation is by recipient address (most recent send) — exact for single-list setups.
- No segmentation or scheduling (yet) — it's the *very simple* mailing list.

## Admin API

Every admin page is backed by a route under `/_emdash/api/plugins/emdash-mailing-list/` that scripts can call with an admin session or Bearer token and the `X-EmDash-Request: 1` header: `overview`, `compose-options`, `preview`, `evaluate`, `send-test`, `send`, `blasts`, `blast`, `subscribers`, `subscriber-action`, `settings-get`, `settings-save`. `send` takes `{ subject, bodyPT? | body?, targets: { includePrimary, sources: { [collection]: { include, values? } }, advanced? } }`.

## Upgrading from 0.6

Storage and settings keys are unchanged, so blasts, sends, the template and the webhook secret carry over. The plugin is now shipped as source (`src/`), like the other native EmDash plugins, so it needs its peers installed in the site: `emdash`, `@emdash-cms/admin`, `@cloudflare/kumo` and `react` — all already present on any site running the EmDash admin.

## Development

```bash
npm install
npm run typecheck
```

Test it in a site with `npm pack` and `npm install ./emdash-mailing-list-<version>.tgz`.

MIT © Woofy
