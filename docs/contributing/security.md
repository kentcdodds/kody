# Security

Security-relevant patterns in the Worker. See the 2026-05-01 internal security
audit for findings and rationale.

## Public connector routes are WebSocket-only

The Worker entrypoint (`packages/worker/src/index.ts`) only forwards connector
route requests (`/home/connectors/...`, `/connectors/...`) when the request
carries a `WebSocket` upgrade header. Non-upgrade HTTP requests are rejected
with `404` before reaching the Durable Object.

As a second layer of defense, the `HomeConnectorSession` Durable Object rejects
non-WebSocket HTTP requests to `/snapshot` and `/rpc/*` unless they carry a
per-isolate internal token (`X-Kody-Internal`). Worker-internal callers set this
header via `internalCallHeaders()` from
`packages/worker/src/home/internal-call-token.ts`.

## Auth rate limiting

`POST /auth` and `POST /password-reset` are rate-limited per IP address using a
KV-backed sliding window (`packages/worker/src/app/rate-limit.ts`). The default
configuration allows 10 requests per 60-second window per IP. Excess requests
receive `429 Too Many Requests` with a `Retry-After` header.

## Maintenance route guard

Any `/__maintenance/*` path that does not match a known handler returns `404`
with a JSON body. This prevents unhandled maintenance paths from falling through
to the SPA shell and silently returning `200 OK`.
