# Inbound webhooks

Package-centered HTTP ingress that dispatches third-party POST payloads to a
bound saved-package export. End-user setup lives in
[`docs/use/webhooks.md`](../../use/webhooks.md).

## Why this exists

Package-invocation HTTP endpoints require `Authorization: Bearer`. Many webhook
providers cannot set custom Authorization headers. Webhook endpoints are the
credential-in-URL sibling of per-user [email](../../use/email-primitives.md)
inboxes, declared alongside other package surfaces in
`package.json#kody.webhooks` (same family as `kody.subscriptions`).

## Manifest contract

Packages declare webhooks as an array under `kody.webhooks`. Each entry has a
slug `name`, an `export` that must exist in `package.json#exports`, optional
`responseMode` (`ack` default / `sync`), and optional HMAC `verification` that
references a secret-store name (`secretName`) — never an inline secret. Parsing
and export existence checks live in `parseAuthoredPackageJson` /
`listPackageWebhooks` (`packages/worker/src/package-registry/`).

Declaring a webhook does **not** open ingress. A minted URL secret in D1 does.

## Ingress path

Route: `POST /@:username/webhooks/:packageKodyId/:webhookName/:urlSecret`

1. Worker `fetch` in `packages/worker/src/index.ts` matches the path early so
   `ExecutionContext.waitUntil` is available for ack-mode dispatch. The path is
   also registered in `routes.ts` / `router.ts`, and `/@*/webhooks/*` is in
   `run_worker_first` for all Wrangler environments.
2. Resolve username → user; resolve `packageKodyId` to a saved package owned by
   that user; load minted row keyed by `(user_id, package_id, webhook_name)`.
3. Unminted, disabled, missing declaration (after republish rename/remove), or
   URL-secret mismatch → **404** (indistinguishable). URL-secret mismatches do
   **not** write a delivery row (avoids log-flush DoS and rate-limit side
   channels).
4. Constant-time compare the URL secret against `url_secret_hash` (SHA-256).
5. After a matching URL secret, enforce per-webhook rate limit (~60/min) →
   **429** (no delivery row on the limited path); payload cap 1 MB → **413**.
6. When verification is declared, resolve `secretName` from the owner's secret
   store (user/package scope via package storage context). Missing secret or
   HMAC mismatch → **401**, with a clear delivery-log error for missing secrets.
7. Dispatch via `invokePackageExport` with a synthetic internal token scoped to
   the owning user / package / export, `source: 'webhook'`.
8. `ack`: **202** + `waitUntil`. `sync`: await (30s) and return export JSON,
   **502** on failure.
9. Authenticated deliveries (and post-auth rejects such as HMAC / size / missing
   declaration) record a `webhook` surface run record (no payload body). See
   [Run records](./run-records.md). URL-secret mismatches and pre-auth rate
   limits still write no delivery history.

## Isolation

- Every D1 row carries `user_id`. Capabilities always bind
  `requireMcpUser(...).userId`.
- Ingress may look up by username + kody id + webhook name, then immediately
  re-scopes by the owning user.
- Account deletion/export include `webhook_endpoints` and any leftover
  `webhook_deliveries` rows (the deliveries table is no longer written; history
  lives in run records). Export redacts `url_secret_hash`.
- Plaintext URL secrets and verification secrets are never logged. URL secrets
  are hashed; verification secrets stay in the secrets primitive.

## Storage

Minted endpoint state is in migration `0090-webhook-endpoints.sql`. Delivery
history is in the per-user `RunLog` Durable Object (`webhook` surface);
`webhook_deliveries` remains in schema until a follow-up drop migration. See
[Data storage](./data-storage.md) and [Run records](./run-records.md).
