# Inbound webhooks

Package-centered HTTP ingress that dispatches third-party POST payloads to a
bound saved-package export. End-user setup lives in
[`docs/use/webhooks.md`](../../use/webhooks.md).

## Why this exists

Package-invocation HTTP endpoints require `Authorization: Bearer`. Many webhook
providers cannot set custom Authorization headers. Webhook endpoints are the
external HTTP knock: credential-in-URL sibling of per-user
[email](../../use/email-primitives.md) inboxes, declared alongside other package
surfaces in `package.json#kody.webhooks` (same family as `kody.subscriptions`).
First-party trusted clients use the same path (URL secret, no Bearer).
Invocation tokens are an unadvertised drain; see
[0048](../decisions/0048-webhooks-replace-invocation-tokens.md).

## Manifest contract

Packages declare webhooks as an array under `kody.webhooks`. Each entry has a
slug `name`, an `export` that must exist in `package.json#exports` (one name ↔
one export; no `*`), optional `responseMode` (`ack` default / `sync`), optional
`inputMode` (`request` default / `params`), optional `rateLimitPerMinute`
(default 60, max 600), optional HMAC `verification` that references a
secret-store name (`secretName`) — never an inline secret — and optional
`replay` for timestamp windows and delivery-id dedupe. Parsing and export
existence checks live in `parseAuthoredPackageJson` / `listPackageWebhooks`
(`packages/worker/src/package-registry/`).

HMAC `verification` signs the raw body by default (`signedPayload` omitted or
`'body'`). Set `signedPayload` to `'timestamp.body'` when the provider HMAC
covers `` `${timestamp}.${rawBody}` `` (Stripe). Replay protection is
**opt-in**: body-only HMAC without `replay` does not bind a timestamp or
delivery id, so a captured signed payload can be replayed until the URL secret
is rotated.

`replay` fields:

- `timestampHeader` — header that carries the timestamp (required with
  `timestampFormat`)
- `timestampFormat` — `unix-seconds` | `unix-millis` | `iso-8601` |
  `stripe-signature` (`stripe-signature` reads `t=<unix>` from a Stripe-style
  header). Unknown formats fail publish-time validation.
- `toleranceSeconds` — optional; defaults to 300 when `timestampHeader` is set
- `deliveryIdHeader` — unique delivery id; dispatches use
  `sha256(userId + packageId + webhookName + deliveryId)` as the
  package-invocation idempotency key. The keyed ledger matches that key alone
  (`idempotencyParamsHash: 'ignore'`): retries change `receivedAt` (and often
  headers), and a later body for the same id is still that delivery. A different
  delivery id hashes to a different key, so it cannot reuse another event's
  acknowledgement.

`inputMode: "params"` is the first-party trusted-client contract. The bound
export's first argument is the parsed JSON object. When that object has a
`params` property that is itself a JSON object, the platform unwraps it
(invoke-token envelope). `Idempotency-Key` (or JSON `idempotencyKey` in params
mode) maps to the same package-invocation ledger with payload hashing
(`include`): same key + same first argument replays. On `sync`, mismatch and
in-progress are **409**. `ack` returns **202** after enqueue; the queue consumer
applies the same ledger asynchronously. Request-mode caller keys hash the JSON
body so `receivedAt` does not break retries. Delivery-id keys stay `ignore`.
HMAC stays optional; the URL secret is enough for a trusted client.

`rateLimitPerMinute` overrides the default 60/min ceiling per minted endpoint.
600/min is the documented maximum for gateway fan-in. The limiter still bounds a
leaked URL.

Declaring a webhook does **not** open ingress. A minted URL secret in D1 does.

## Ingress path

Route: `POST /@:username/webhooks/:packageKodyId/:webhookName/:urlSecret`

1. Worker `fetch` in `packages/worker/src/index.ts` matches the path early. The
   path is also registered in `routes.ts` / `router.ts`, and `/@*/webhooks/*` is
   in `run_worker_first` for all Wrangler environments.
2. Resolve username → user; resolve `packageKodyId` to a saved package owned by
   that user; load minted row keyed by `(user_id, package_id, webhook_name)`.
3. Unminted, disabled, missing declaration (after republish rename/remove), or
   URL-secret mismatch → **404** (indistinguishable). URL-secret mismatches do
   **not** record delivery history (avoids log-flush DoS and rate-limit side
   channels).
4. Constant-time compare the URL secret against `url_secret_hash` (SHA-256) and,
   during rotate overlap, the previous hash. The previous URL stays active for
   24 hours or until the first POST on the new URL that is accepted for dispatch
   (ack enqueue or sync invoke), whichever comes first. HMAC, rate limit,
   payload, and declaration rejects do not retire the previous URL. An expired
   previous hash is treated as unknown.
5. After a matching URL secret, enforce per-webhook rate limit (declared
   `rateLimitPerMinute` when the name is still live, otherwise the default 60,
   max 600) → **429** (no delivery history on the limited path). Missing
   declaration after republish rename/remove still **404**s and records a
   rejected delivery, but only after that limit. Payload cap 1 MB → **413**.
6. When verification is declared, resolve `secretName` from the owner's secret
   store (user/package scope via package storage context). Missing secret or
   HMAC mismatch → **401**, with a clear delivery-log error for missing secrets.
   When `replay.timestampHeader` is declared, a missing, unparseable, or stale
   timestamp is rejected with the same generic **401** before dispatch (and
   before any run record that implies acceptance). When
   `replay.deliveryIdHeader` is declared, a missing id is rejected the same way;
   present ids become the invocation idempotency key.
7. Dispatch via `invokePackageExport` with a synthetic internal token scoped to
   the owning user / package / export, `source: 'webhook'`.
8. `ack`: await enqueue to `kody-webhook-dispatch`, then return **202**. The
   queue consumer owns the full invocation and its terminal writes, so work is
   not tied to the post-response `waitUntil` window. A failed enqueue returns
   **503** so the provider can retry. Queue messages omit reconstructed
   `params.request.json` (the consumer parses `body`) and spill `body` to
   `BUNDLE_ARTIFACTS_KV` under
   `webhook-dispatch-payload:v1:{userId}:{deliveryId}` when the serialized
   message would exceed a conservative 120 KB ceiling beneath Cloudflare Queues'
   128 KB limit. `sync`: await (30s) and return export JSON, **502** on failure.
9. Authenticated deliveries (and post-auth rejects such as HMAC / size / missing
   declaration) record a `webhook` surface run record (no payload body). See
   [Run records](./run-records.md). URL-secret mismatches and pre-auth rate
   limits still write no delivery history.

Ack messages carry the accepted delivery id, idempotency key, scoped endpoint
identity, export name, and already-authenticated payload (inline `body`, or a
user-scoped KV key when the body was spilled). Queue retries reuse that exact
idempotency key. Request-mode caller `Idempotency-Key` messages set
`callerIdempotency` so the consumer hashes the JSON body (same as sync).
Unique-key ack claims omit that flag and hash the `{ webhook, request }`
envelope. Transient ledger lookup/terminal-persistence failures and
still-in-progress replays are retried; terminal package errors are recorded and
acknowledged. A missing spilled body is a terminal failure
(`ack_queue_payload_missing`). The package export sandbox retains its normal
~90s budget, so genuinely longer package work ends as an explicit timeout rather
than an unknown interrupted outcome.

The Queue consumer batch size is one. Processing is sequential and one export
can consume the full sandbox budget, so larger batches could exceed the Queue
consumer's 15-minute wall-clock limit before later messages are acknowledged.

## Isolation

- Every D1 row carries `user_id`. Capabilities always bind
  `requireMcpUser(...).userId`.
- Ingress may look up by username + package name leaf + webhook name, then
  immediately re-scopes by the owning user.
- Account deletion/export include `webhook_endpoints` (minted URL state).
  Delivery history lives in run records and is covered with the rest of `RunLog`
  export/deletion. Export redacts `url_secret_hash`, `url_secret_encrypted`, and
  `previous_url_secret_hash`.
- Plaintext URL secrets and verification secrets are never logged. URL secrets
  are hashed for ingress and stored encrypted for `webhookUrlApply` and the
  owner reveal in package settings. MCP mint, rotate, list, and apply never
  return the credential URL. Verification secrets stay in the secrets primitive.

## Owner UI

Webhooks belong to the package that declares them, so the owner surface is the
**Webhooks** section of package settings (`/@:username/:kodyId/settings`,
`packages/worker/client/routes/package-webhook-settings.tsx` with one
`package-webhook-card.tsx` per declared webhook). Its JSON companion is
`/profiles/:username/packages/:kodyId/webhooks.json`
(`packages/worker/src/app/handlers/package-webhooks.ts`). The handler is
owner-only: the signed-in user must be `:username` and own `:kodyId`, otherwise
it answers 404 without naming the package or its webhooks. `GET` returns
`listWebhooksForUser` filtered to the package and joined with `urlRecoverable`
and `previousUrlActiveUntil`, never the URL. `POST { intent, webhookName }`
intents `mint`, `rotate`, and `reveal` return the refreshed list plus a
`revealed` entry built by `revealWebhookUrlForWebsite` (decrypt
`url_secret_encrypted`, rebuild the ingress path from the request origin);
`enable` / `disable` return the list only. Every intent writes an `account`
audit event (`webhook_url_mint`, `webhook_url_rotate`, `webhook_url_reveal`,
`webhook_enable`, `webhook_disable`). `mint` refuses an already-minted webhook
so a stray click cannot rotate a provider's URL; `reveal` refuses mints without
`url_secret_encrypted` and points at Rotate. The client keeps revealed URLs in
memory only and drops them on Hide or when the settings page changes package.

`/account/webhooks` (`packages/worker/client/routes/account-webhooks.tsx`,
`packages/worker/src/app/handlers/account-webhooks.ts`) is a thin cross-package
index. `GET /account/webhooks.json` lists every declared webhook (never a URL)
and each row deep-links to `/@:username/:kodyId/settings#webhook-<name>`. The
account API has no mutating intents.

`revealWebhookUrlForWebsite` is website-only: no MCP capability, execute
binding, or apply result may return the credential URL.

## Storage

Minted endpoint state lives in the D1 `webhook_endpoints` table defined by
`packages/worker/migrations/0001-squashed-init.sql`, with `url_secret_encrypted`
added in `0057-webhook-url-secret-encrypted.sql` and rotate-overlap columns in
`0062-webhook-url-rotation-grace.sql`. Rotate copies the outgoing hash to
`previous_url_secret_hash` with `previous_url_secret_expires_at` 24 hours out.
The previous ciphertext is not stored: reveal and apply always rebuild the
current URL. `webhookUrlMint` / `webhookUrlRotate` return an opaque `handle`
(`whh_<id>`) and `url_host`. `webhookUrlApply` resolves the handle inside Kody
and registers the URL through a first-class destination adapter (GitHub
repository hooks via the user GitHub integration or a host-approved GitHub
token). The credential is injected into the provider API field; apply does not
accept an arbitrary outbound URL. Delivery history is in the per-user `RunLog`
Durable Object (`webhook` surface), not in D1. See
[Data storage](./data-storage.md) and [Run records](./run-records.md).
