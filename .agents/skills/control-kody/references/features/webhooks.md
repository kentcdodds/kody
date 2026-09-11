# Webhooks

Owner-only home for inbound webhook URLs: every webhook a saved package declares
(`package.json#kody.webhooks`) joined with its minted state. Mint, reveal +
copy, rotate, disable, and enable happen here; MCP never returns the credential
URL.

## How to get there

`/account/webhooks` (account rail → Webhooks) →
`/account/webhooks/:packageKodyId/:webhookName` expands one row.

## Drive it

```bash
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/webhooks.json
node tools/control-kody.ts request POST /account/webhooks.json \
  --json '{"intent":"mint","packageKodyId":"<kodyId>","webhookName":"<name>"}'
```

## APIs

- `GET /account/webhooks.json` — `{ ok, username, webhooks[] }`; no URL, no
  secret. `urlRecoverable` is false for mints that predate encrypted storage.
- `POST /account/webhooks.json` —
  `{ intent: 'mint' | 'rotate' | 'reveal' | 'enable' | 'disable', packageKodyId, webhookName }`.
  `mint`, `rotate`, and `reveal` add `revealed: { id, handle, url }`; the URL
  origin follows the request so previews show their own host.

## Gotchas

- Seed users own no packages, so the list is empty until a saved package
  declares a webhook. Publish one with `kody.webhooks` first (the MCP
  `webhookList` capability sees the same rows).
- `mint` on an already-minted webhook is a 400 (“Rotate it”); the UI only shows
  Mint for unminted rows. Rotate and Disable are double-check buttons.
- `reveal` on a legacy mint without `url_secret_encrypted` is a 400; the page
  offers Rotate instead.
- Every intent writes an `account` audit event (`webhook_url_reveal`, …).
