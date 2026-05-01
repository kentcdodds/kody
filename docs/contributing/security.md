# Security

Security-relevant patterns in the Worker. See the 2026-05-01 internal security
audit for findings and rationale.

## Public connector routes are WebSocket-only

The Worker entrypoint (`packages/worker/src/index.ts`) only forwards connector
route requests (`/home/connectors/...`, `/connectors/...`) when the request
carries a `WebSocket` upgrade header. Non-upgrade HTTP requests are rejected
with `404` before reaching the Durable Object.

As a second layer, the `HomeConnectorSession` Durable Object `fetch()` handler
rejects all non-WebSocket requests with `404`. Worker-internal callers use
Durable Object RPC methods (`getSnapshot()`, `rpcListTools()`, `rpcCallTool()`)
directly on the stub, bypassing `fetch()` entirely.

## Auth rate limiting

`POST /auth` and `POST /password-reset` are rate-limited per IP address using a
D1-backed atomic rate limiter (`packages/worker/src/app/rate-limit.ts`). The
default configuration allows 10 requests per 60-second window per IP. Excess
requests receive `429 Too Many Requests` with a `Retry-After` header. The D1
approach uses a batched INSERT + COUNT in a single transaction, avoiding the
read-then-write race condition that KV-backed rate limiters suffer from under
concurrent requests.

## Maintenance route guard

Any `/__maintenance/*` path that does not match a known handler returns `404`
with a JSON body. This prevents unhandled maintenance paths from falling through
to the SPA shell and silently returning `200 OK`.
