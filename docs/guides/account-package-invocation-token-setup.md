---
id: package_invocation_token_setup
title: External HTTP knock
summary:
  Map leftover invocation-token callers to inbound webhooks. One webhook name
  binds one export; mint a URL and POST JSON.
unadvertised: true
category: platform
---

# External HTTP knock

Inbound webhooks are the external HTTP knock. Package invocation tokens stay as
an unadvertised drain until leftover rows are gone. Do not invent a second
bearer grant.

## Destination map

| Job                                  | Destination            | How                                                                                          |
| ------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------- |
| Vendor POST (Sentry, GitHub, Stripe) | inbound webhooks       | `kody.webhooks` with `inputMode: "request"`, optional HMAC + `replay`, then `webhookUrlMint` |
| First-party trusted client           | inbound webhooks       | `inputMode: "params"`, `Idempotency-Key`, `sync` or `ack`, one webhook per export            |
| Multi-export / `*` token             | one webhook per export | No wildcard URL. Declare each export the client actually calls.                              |
| Author composition                   | import / workflows     | Static `import`, `import(specifier)`, or workflows. Not HTTP.                                |

Discord gateways, YouTube WebSub, Raycast extensions, and social-launch clients
mint one webhook URL per export and POST JSON. Vendor HMAC handlers stay on
`inputMode: "request"`.

See [Inbound webhooks](../use/webhooks.md). `webhookUrlMint` returns the
credential URL once. Do not create new invocation tokens.
