# Webhooks

Owner-only management of inbound webhook URLs. Webhooks belong to the package
that declares them (`package.json#kody.webhooks`), so mint, reveal + copy,
rotate, disable, and enable live in that package's settings. MCP never returns
the credential URL.

## How to get there

`/@<username>/<kodyId>/settings#webhooks` (package page → Settings → Webhooks
section) renders one card per declared webhook; `#webhook-<name>` targets one
card.

`/account/webhooks` (account rail → Webhooks) is a read-only index across
packages; each row deep-links to the card above.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /profiles/<username>/packages/<kodyId>/webhooks.json
node tools/control-kody.ts request POST /profiles/<username>/packages/<kodyId>/webhooks.json \
  --json '{"intent":"mint","webhookName":"<name>"}'
node tools/control-kody.ts request GET /account/webhooks.json
```

## APIs

- `GET /profiles/:username/packages/:kodyId/webhooks.json` —
  `{ ok, username, kodyId, webhooks[] }`; no URL, no secret. `urlRecoverable` is
  false for mints that predate encrypted storage. Owner-only: another username
  or an unknown package is a 404.
- `POST /profiles/:username/packages/:kodyId/webhooks.json` —
  `{ intent: 'mint' | 'rotate' | 'reveal' | 'enable' | 'disable', webhookName }`.
  `mint`, `rotate`, and `reveal` add `revealed: { id, handle, url }`; the URL
  origin follows the request so previews show their own host.
- `GET /account/webhooks.json` — `{ ok, username, webhooks[] }` across every
  package; read-only (POST is 405).

## Gotchas

- Seed users own no packages, so both surfaces are empty until a saved package
  declares a webhook. Publish one with `kody.webhooks` first (the MCP
  `webhookList` capability sees the same rows).
- The settings section loads its rows after the settings shell (same as Share);
  hash deep links wait for it.
- `mint` on an already-minted webhook is a 400 (“Rotate it”); the card only
  shows Mint for unminted rows. Rotate and Disable are double-check buttons.
  Rotate keeps the previous URL active for 24 hours, or until a delivery arrives
  on the new URL; the card shows “Previous URL active until …” during that
  overlap.
- `reveal` on a legacy mint without `url_secret_encrypted` is a 400; the card
  offers Rotate instead.
- Every intent writes an `account` audit event (`webhook_url_reveal`, …).
