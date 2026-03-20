# Request lifecycle

This document explains how an incoming request moves through the system.

## Entry point

All traffic enters the Worker at `packages/worker/src/index.ts`.

The default `fetch` handler delegates to `OAuthProvider` from
`@cloudflare/workers-oauth-provider`, which means OAuth endpoints and token
infrastructure are available alongside normal app routes.

Before that, `GET`/`HEAD`/`OPTIONS` on `/.well-known/oauth-protected-resource`
are handled in `packages/worker/src/index.ts` itself. The OAuth provider
library’s built-in handler for that path advertises `resource` as the request
**origin** only; this app’s MCP server is identified by `<origin>/mcp`. Serving
our own metadata on that URL keeps the RFC 8707 `resource` value consistent for
clients (e.g. some MCP stacks) that discover metadata from the 401
`resource_metadata` URL and would otherwise get `invalid_target` at the token
endpoint.

## Routing order

Requests are handled in this order:

1. Protected resource metadata (base path only, before `OAuthProvider`):
   - `/.well-known/oauth-protected-resource` (`GET` / `HEAD` / `OPTIONS`)
2. OAuth authorization endpoints:
   - `/oauth/authorize`
   - `/oauth/authorize-info`
   - `/oauth/callback`
3. Browser noise endpoint:
   - `/.well-known/appspecific/com.chrome.devtools.json` (returns 204)
4. OAuth protected resource metadata endpoint (inside the default handler, for
   the `/mcp` suffix path only):
   - `/.well-known/oauth-protected-resource/mcp`
5. MCP endpoint:
   - `/mcp` (requires OAuth bearer token)
6. Internal chat agent endpoint:
   - `/chat-agent/:threadId...` (requires the app session cookie and routes to
     the per-thread chat Agent instance)
7. Static assets:
   - Served from `ASSETS` for `GET` and `HEAD` when available
8. App server routes:
   - Everything else is handled by `server/handler.ts`

## App server flow

`server/handler.ts` validates environment variables and configures session
cookie signing (`COOKIE_SECRET`) before creating the app router.

`server/router.ts` maps route patterns from `server/routes.ts` to handler
modules (home, auth, account, session, logout, password reset, health).

## Client-side navigation flow

The browser app intercepts same-origin `<a>` clicks and same-origin form
submissions (`GET`/`POST`) and routes them in-place through the client router.
Normal app navigations no longer require a full document refresh.

Full page navigations still occur for:

- Explicit browser reloads/new tab loads
- Cross-origin links/forms
- Non-`_self` form targets (for example, `_blank`)
- Explicit code paths that intentionally call `window.location.assign(...)`

## CORS behavior

`packages/worker/src/index.ts` wraps the handler with `withCors`:

- CORS headers are only added when `Origin` exactly matches the request origin.
- Allowed methods are `GET, POST, OPTIONS`.
- Allowed headers include `content-type` and `authorization`.

This keeps cross-origin behavior narrow while still allowing same-origin browser
and API requests.

## Observability (Sentry)

The Worker default export is wrapped with `Sentry.withSentry` from
`@sentry/cloudflare` (see `packages/worker/src/index.ts`) so incoming `fetch`
requests are traced and uncaught errors can be reported when `SENTRY_DSN` is
configured.

The **MCP** (`MCP` / `MCP_OBJECT`) and **chat** (`ChatAgent`) Durable Objects
are each wrapped with `Sentry.instrumentDurableObjectWithSentry` (see
`mcp/index.ts` and `packages/worker/src/chat-agent.ts`) because they run in
separate isolates from the top-level Worker.

Shared options are built in `sentry/cloudflare-options.ts`: **release** comes
from `APP_COMMIT_SHA` when set (deploy workflows pass it as a var), and
**environment** defaults from `SENTRY_ENVIRONMENT` in
`packages/worker/wrangler.jsonc` per deploy target.

MCP tools emit structured `mcp-event` logs via `mcp/observability.ts`. On
failures, the same module sends Sentry events (with MCP tags and context);
sandbox user-code failures are reported at **warning** severity, while
capability handler bugs use **error**.

### Source maps

`packages/worker/wrangler.jsonc` sets
[`upload_source_maps`](https://developers.cloudflare.com/workers/wrangler/configuration/#source-maps),
and `bun run deploy` passes
`--outdir .wrangler/sentry-bundle --upload-source-maps` so the bundle + maps are
generated consistently. To symbolicate stack traces in **Sentry** (not only in
Cloudflare), configure
[Cloudflare source maps in Sentry](https://docs.sentry.io/platforms/javascript/guides/cloudflare/sourcemaps/):
add GitHub **repository variables** `SENTRY_ORG` and `SENTRY_PROJECT`, a
`SENTRY_AUTH_TOKEN` **secret** with release upload scopes, then CI runs
`bun run sentry:upload-sourcemaps` after deploy using the same **release** as
`APP_COMMIT_SHA`.
