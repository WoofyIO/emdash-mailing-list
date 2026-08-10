# emdash-mailing-list

A *very* simple mailing list for [EmDash CMS](https://docs.emdashcms.com): signup with double opt-in, one-click unsubscribe, admin-composed mail blasts, per-blast delivery status, and automatic bounce handling via [Postal](https://postalserver.io) webhooks.

Email is delivered through whatever email provider the site already has configured (e.g. [emdash-postal](https://github.com/undefined-charity/emdash-postal)) — this plugin adds the list, not the transport.

## Features

- **Signup** — public JSON endpoint with an email-format check and a honeypot field; safe to call from any site form
- **Double opt-in** — subscribers confirm via an emailed link before they ever receive a blast
- **Unsubscribe** — tokenized one-click link appended to every blast automatically
- **Blasts** — compose plain text in the admin (blank line = paragraph); queued and sent in rate-limited batches by a cron task, with live sent/delivered/failed/bounced counts
- **Test sends** — send the composed blast to a single address before the real thing
- **Bounce handling** — a webhook endpoint for Postal delivery events: hard bounces and hard failures remove the address from the list immediately, three soft failures do the same, `MessageSent` upgrades a send to *delivered*
- **Admin page** — subscriber stats and latest signups, manual add/remove, blast history, settings, and copy-paste wiring instructions — all under **Mailing List** in the admin sidebar

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

Open **Admin → Mailing List** once after deploying — that first page load provisions the send-queue cron and the webhook secret.

## Wire up your site

### Signup form

POST JSON to the public endpoint. Include an empty `website` field as a bot honeypot.

```html
<form id="signup">
  <input type="email" name="email" required />
  <input type="text" name="website" style="position:absolute;left:-9999px" tabindex="-1" aria-hidden="true" />
  <button>Join the list</button>
</form>
<script>
  document.getElementById("signup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const res = await fetch("/_emdash/api/plugins/emdash-mailing-list/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.email.value, website: form.website.value }),
    });
    const json = await res.json();
    alert(json.data?.ok ? "Check your inbox to confirm!" : "That address didn't look right.");
  });
</script>
```

### Confirm / unsubscribe pages

Emails link to `/mailing/confirm?token=…` and `/mailing/unsubscribe?token=…` on your site (paths configurable via the plugin KV keys `settings:confirmPath` / `settings:unsubscribePath`). Add two small server-rendered pages that forward the token to the plugin and show a branded result:

```astro
---
// src/pages/mailing/confirm.astro  (unsubscribe.astro is identical with s/confirm/unsubscribe/)
const token = Astro.url.searchParams.get("token") ?? "";
const res = await fetch(
  `${Astro.url.origin}/_emdash/api/plugins/emdash-mailing-list/confirm?token=${encodeURIComponent(token)}`,
);
const { data } = await res.json();
---
{data?.state === "confirmed" ? <h1>You're on the list!</h1> : <h1>That link didn't work.</h1>}
```

### Postal bounce webhook

The admin page shows your webhook URL (it includes a generated secret):

```
https://your-site.com/_emdash/api/plugins/emdash-mailing-list/webhook?key=<secret>
```

In Postal: **Server → Webhooks → Add webhook**, paste the URL, and select the events `MessageSent`, `MessageDeliveryFailed`, `MessageBounced`, and `MessageHeld`. That's the whole bounce pipeline: hard bounces flip the subscriber to `bounced` (they stop receiving blasts), and delivery confirmations upgrade blast stats from *sent* to *delivered*.

## Notes & limits

- Blasts are plain text (with an auto-generated simple HTML alternative). No templates, no segmentation, no scheduling — it's the *very simple* mailing list.
- Batch size defaults to 25 sends/minute (configurable 1–100 in the admin) to stay friendly to Workers subrequest limits and your mail server's rates.
- Subscribers live in EmDash plugin storage (your site's own database) — they ride along with whatever database backups you already run.
- Bounce correlation is by recipient address (most recent send), which is exact for a single-list setup like this one.
- The webhook authenticates via the secret in the URL rather than Postal's RSA signature — treat the URL as a credential.

## Development

```bash
npm install
npm run build      # tsdown → dist/
npm run typecheck
```

`dist/` is committed so the package installs cleanly from GitHub without running build scripts.

MIT © Woofy
