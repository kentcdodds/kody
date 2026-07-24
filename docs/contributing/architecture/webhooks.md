# Inbound webhooks

User-owned HTTP ingress that dispatches third-party POST payloads to a bound
saved-package export. End-user setup lives in
[`docs/use/webhooks.md`](../../use/webhooks.md).

## Why this exists

Package-invocation HTTP endpoints require `Authorization: Bearer` (see
`packages/worker/src/package-invocations/http.ts`). Many webhook providers
cannot set custom Authorization headers. Webhook endpoints are the
credential-in-URL sibling of per-user [email](../../use/email-primitives.md)
inboxes: a public `POST` route that re-establishes ownership, verifies optional
signatures, and invokes the owner's package export through the existing
package-invocation runtime.

## Ingress path

Route: `POST /@:username/webhooks/:endpointId/:urlSecret`

1. Worker `fetch` in `packages/worker/src/index.ts` matches the path early (same
   class of public `@username` ingress as package invocations) so
   `ExecutionContext.waitUntil` is available for ack-mode dispatch.
2. The path is also registered in `packages/worker/src/app/routes.ts` /
   `router.ts`, and `/@*/webhooks/*` is in `run_worker_first` for all Wrangler
   environments.
3. Resolve `webhook_endpoints` by `endpointId`. Unknown or disabled → **404**.
4. Resolve `:username` via `findPublicUserIdentityByUsername` and require
   `mcpUserId === endpoint.userId`. Mismatch → **404** (and a rejected delivery
   row for the owner).
5. Constant-time compare the URL secret against `url_secret_hash` (SHA-256).
   Mismatch → **404**.
6. Enforce per-endpoint rate limit (~60/min) → **429**; payload cap 1 MB →
   **413**.
7. When `verification_config` is set, decrypt the HMAC secret with
   `SECRET_STORE_KEY`, verify over the raw body → **401** on failure.
8. Dispatch via `invokePackageExport` with a synthetic internal token scoped to
   the endpoint's `userId`, `packageId`, and `exportName`, `source: 'webhook'`.
9. `response_mode = ack`: respond **202** and run invocation in `waitUntil`.
   `sync`: await (30s timeout) and return the invocation JSON, **502** on
   failure.
10. Every request records a `webhook_deliveries` row (no payload body). At most
    ~50 rows are retained per endpoint (prune on insert).

## Isolation

- Every D1 row carries `user_id`. Capability CRUD always binds
  `requireMcpUser(...).userId`.
- Ingress may look up by endpoint id globally, then immediately re-scopes by the
  owning user and username match — the same pattern as email address routing.
- Account deletion/export include `webhook_deliveries` then `webhook_endpoints`.
  Export redacts `url_secret_hash` and `verification_config`.
- Plaintext URL secrets and verification secrets are never logged. URL secrets
  are hashed; verification secrets are encrypted at rest.

## Storage

See migration `0090-webhook-endpoints.sql` and
[Data storage](./data-storage.md).
