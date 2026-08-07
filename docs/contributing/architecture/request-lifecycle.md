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
endpoint. Protected-resource metadata and MCP auth challenges resolve the origin
from the inbound request URL (via `getAppBaseUrl`) so clients connecting through
`heykody.dev` or a workers.dev host get matching resource values. `APP_BASE_URL`
is only the fallback for background work with no request URL.

## Routing order

Requests are handled in this order:

0. Package-app host isolation (before everything else — see
   [Hosted package app origin isolation](../security.md#hosted-package-app-origin-isolation)):
   - On the **package-app origin**, only `/@{username}/packages/*` is served
     (plus the handoff-token exchange on those same paths). `/` redirects to the
     app origin; every other path is `404`.
   - On the **app origin**, `/@{username}/packages/*` never executes package
     code: safe methods redirect to the package-app origin with a handoff token,
     other methods get a `307` to the same path there.
   - Production package-app requests fail with `500` when `PACKAGE_APP_BASE_URL`
     is missing or is not on a separate registrable domain from `APP_BASE_URL`;
     package code never executes inline.
   - In confirmed local, preview, and test runtimes, an unset package-app origin
     is a no-op and package apps are served inline at step 9 below.
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
   - `/mcp` (requires OAuth bearer token). After authentication,
     `packages/worker/src/mcp-auth.ts` routes by protocol era: 2025-era requests
     go to the sessionful `MCP` Durable Object (`McpAgent`, MCP SDK v1), and
     `2026-07-28` envelope requests are served statelessly per request by
     `packages/worker/src/mcp/stateless-lane.ts` (MCP SDK v2, no Durable
     Object). Both lanes share one tool registration; every authenticated
     request records a lane data point to the `MCP_PROTOCOL_EVENTS` Analytics
     Engine dataset so the legacy lane can be retired once its traffic stops
     (see
     [decision 0005](../decisions/0005-mcp-dual-lane-stateless-migration.md)).
6. Public `@username` ingress handled in `packages/worker/src/index.ts` before
   the OAuth provider / app router (needs `ExecutionContext` for background
   work):
   - `POST /@{username}/api/package-invocations/:kodyId/:exportName` — bearer
     token package invocations
   - `POST /@{username}/webhooks/:packageKodyId/:webhookName/:urlSecret` —
     inbound package webhooks (see [Inbound webhooks](./webhooks.md))
7. Remote connector session endpoints (internal-only Worker routes that proxy
   WebSocket upgrades to the remote connector session Durable Object;
   non-upgrade requests get a 404 — JSON-RPC helper access uses Durable Object
   RPC methods, not HTTP routes):
   - `/@{username}/connectors/:instanceId...` — username + connector name

   See [Remote connectors](./remote-connectors.md).

8. Static assets:
   - Served from `ASSETS` for `GET` and `HEAD` when available
   - Matching files under `packages/worker/public/` are asset-first at the edge
     (they do not enter this Worker list). That includes OpenAI Apps domain
     verification at `/.well-known/openai-apps-challenge`.
9. Hosted package apps served inline on the app origin
   (`/@{username}/packages/*`), only in confirmed non-production runtimes when
   `PACKAGE_APP_BASE_URL` is unset.
10. App server routes:
    - Everything else is handled by `packages/worker/src/app/handler.ts`

## Package service runtime

Saved packages may also declare long-lived package services under
`package.json#kody.services`.

- Package services are **not** routed through a public HTTP path the way package
  apps are.
- Instead, the Worker hosts them via the `PackageServiceInstance` Durable Object
  binding and controls them through package runtime bridges and MCP
  capabilities.
- Package services share package identity with apps/jobs and can publish into
  package app realtime sessions, but they own their own durable storage bucket
  and lifecycle.

## Workflow runtime

All server-side Kody runtime contexts expose `workflows` from `kody:runtime`.
The helper routes every call to the shared `DynamicCallableWorkflow` binding;
there is no separate context-specific Workflow class.

- `workflows.create({ code, runAt, idempotencyKey, params })` queues an inline
  ESM module and later executes it through the same module loader used by
  `execute`.
- `workflows.create({ exportName, packageId?, runAt, idempotencyKey, params })`
  queues a saved-package export invocation. Package runtime contexts resolve
  `packageId` from `packageContext`; ad hoc contexts must pass it explicitly.
- The hub verifies saved-package ownership before queuing export-backed
  workflows and records recent workflow rows for `workflow_run_list`.

## App server flow

`packages/worker/src/app/handler.ts` validates environment variables and
configures session cookie signing (`COOKIE_SECRET`) before creating the app
router.

`packages/worker/src/app/router.ts` maps route patterns from
`packages/worker/src/app/routes.ts` to handler modules (home, auth, account,
session, logout, password reset, health).

## Syntax highlighting

Browser pages that show code — markdown bodies on guides, blog posts, and
community READMEs, onboarding MCP config snippets, and JSON dumps on account
jobs/activity — highlight with [Shiki](https://shiki.style/). The Worker uses a
fine-grained sync highlighter (`createHighlighterCoreSync` + the JavaScript
regex engine, no Oniguruma WASM) with a fixed language set and GitHub light/dark
dual themes. Tokens become Remix JSX text and inline styles, never `innerHTML`,
so untrusted README fences stay inside the markdown safety model. Theme
switching follows `:root[data-theme]` (and `prefers-color-scheme` when no theme
is set) via CSS variables in `packages/worker/public/styles.css`.

## Client-side navigation flow

The browser app intercepts same-origin `<a>` clicks and same-origin form
submissions (`GET`/`POST`) and routes them in-place through the client router.
Normal app navigations stay in-place through the client router instead of
requiring a full document refresh.

### Preload-then-commit

SPA navigations use a **preload-then-commit** model (similar to React Router
data routers): before `history.pushState` and the route swap, the client router
runs a registered **route loader** for the destination URL, fetches JSON API
data, and stores it in a single-slot preloaded navigation store. Only after the
loader finishes (or is skipped when no loader matches) does the router commit
the URL change and notify subscribers. Route components consume that payload
synchronously on first render via `tryConsumeRouteLoaderData`, so the UI updates
once with data already present instead of swapping routes into a loading state.
Because consumption mutates route closure state mid-render, a successful consume
also schedules one follow-up render of the consuming component (flushed in the
same microtask, before paint); values a route derived before the consume call
therefore cannot persist stale. Routes should still consume before deriving
list/detail state — the follow-up render is a safety net, not the primary
ordering contract.

Route loaders are registered in `packages/worker/client/routes/index.tsx` under
`clientRouteLoaders`, keyed by `routePattern(routes.<name>)`. The same keying
scheme is used by `clientRoutes` and `document-head.ts`, so pathname renames
flow from `packages/worker/src/app/routes.ts` instead of duplicated literal
strings. OAuth authorize/callback are the exception: those shells use
`oauthPaths.authorize` and `oauthPaths.callback` because the Cloudflare OAuth
provider wrapper, not `routes.ts`, owns those pathnames. Loaders still match
with the same Remix route-pattern specificity as `clientRoutes`. They return a
`RouteLoaderRedirect` (via `routeLoaderRedirect`) to abort the SPA navigation
with a full-document redirect (for example, `401` → login). The router performs
the redirect, never the loader itself, so speculative loader runs stay side-
effect free. Loader errors still commit the navigation so the destination route
can fall back to its own fetch; the router marks the destination stale
(`markNavigationDataStale`) so same-path refreshes — where no href change would
otherwise trigger a refetch — still reload. Hash-only changes commit immediately
without a loader. Back/forward (`popstate`) and same-path refreshes after form
POST also run loaders before notifying, keeping the previous UI visible until
data is ready.

### Intent prefetch

Like React Router's `prefetch="intent"`, the client router speculatively runs
the destination's route loader when the user shows intent to navigate —
`mouseover`, `focusin`, or `touchstart` on a same-origin link with a registered
loader (`intent-prefetch.ts`). A single latest-wins slot holds the speculative
run; hovering a different link aborts the previous prefetch. When the click
lands, the navigation adopts the in-flight or freshly settled prefetch instead
of starting the loader from scratch; results expire after a short TTL and
failures fall back to a normal loader run. Form POSTs abort any pending prefetch
so pre-mutation data is never shown. Opt a link out with `data-prefetch="none"`.

A thin top-of-viewport **navigation progress bar** listens for `navigationstart`
/ `navigationend` on `routerEvents` and appears only when a navigation is still
pending after a short delay.

The app shell also mounts **scroll restoration** for SPA navigations. The router
saves each history entry's window scroll position, restores it on back/forward,
scrolls to hash targets when present, and otherwise scrolls new navigations to
the top after the destination route commits. Same-document hash links (for
example the landing page's `#invite` waitlist CTA) are intercepted like other
same-origin links so restoration can scroll to the target — native fragment
scrolling is disabled while history scroll restoration is `manual`. Preserve the
current scroll for a specific intercepted link or form with
`data-prevent-scroll-reset`, or for programmatic navigation with
`navigate(to, { preventScrollReset: true })`.

Full page navigations occur for:

- Explicit browser reloads/new tab loads
- Cross-origin links/forms
- Non-`_self` form targets (for example, `_blank`)
- Explicit code paths that intentionally call `window.location.assign(...)`

## CORS behavior

`packages/worker/src/index.ts` wraps the handler with `withCors`
(`getCorsHeaders`):

- For `/mcp`, any `Origin` is reflected so browser-hosted remote MCP clients can
  connect: allowed methods are `GET, HEAD, POST, DELETE, OPTIONS`, allowed
  headers include the MCP protocol headers, and `WWW-Authenticate` /
  `Mcp-Session-Id` are exposed so clients can read the OAuth challenge.
- For every other path, CORS headers are only added when `Origin` exactly
  matches the request origin; allowed methods are `GET, POST, OPTIONS` and
  allowed headers include `content-type` and `authorization`.

This keeps cross-origin behavior narrow while allowing same-origin browser and
API requests, plus the deliberate `/mcp` exception.

## Observability (Sentry and Workers tracing)

The Worker default export is wrapped with `Sentry.withSentry` from
`@sentry/cloudflare` (see `packages/worker/src/index.ts`) so incoming `fetch`
requests are traced and uncaught errors can be reported when `SENTRY_DSN` is
configured.

The **MCP** (`MCP` / `MCP_OBJECT`) Durable Object is wrapped with
`Sentry.instrumentDurableObjectWithSentry` (see
`packages/worker/src/mcp/index.ts`) because it runs in a separate isolate from
the top-level Worker.

The remote connector flow adds one more Durable Object:

- The remote connector session Durable Object terminates outbound websocket
  connections from connector processes and proxies JSON-RPC/MCP requests over
  those sockets.

The runtime capability registry **merges** synthesized domains from **remote
connectors** listed in MCP caller context (`remoteConnectors`), enabled **MCP
client servers**, and user **OpenAPI provider bindings**. See
[Remote connectors](./remote-connectors.md),
[MCP client servers](./mcp-client-servers.md), and
[OpenAPI provider bindings](./openapi-bindings.md).

Shared options are built in `packages/worker/src/sentry-options.ts`: **release**
comes from `APP_COMMIT_SHA` when set (deploy workflows pass it as a var), and
**environment** defaults from `SENTRY_ENVIRONMENT` in
`packages/worker/wrangler.jsonc` per deploy target.

MCP tools emit structured `mcp-event` logs via
`packages/worker/src/mcp/observability.ts`. On failures, the same module sends
Sentry events at **error** severity (with MCP tags and context). Failures the
caller can clear from the message alone — `McpCallerError`,
`failurePhase: 'parse_input'`, or an explicit `callerError` payload flag,
including sandbox user-code failures — stay on the structured `mcp-event` log
line and never reach Sentry; genuine platform failures still do. New "not found
/ bad argument" throw sites in `packages/worker/src/mcp/**` should use
`McpCallerError`.

Authentication and authorization denials are deliberately **not**
`McpCallerError`. `/mcp` rejects anonymous callers at the transport before any
capability runs, so a denial reaching a handler means an internal caller built a
context without a user — a defect worth an issue. Attack visibility for these
lives in the audit log rather than the error stream; see
[Security](../security.md).

### Workers native tracing (OpenTelemetry)

`packages/worker/wrangler.jsonc` also enables
[Workers automatic tracing](https://developers.cloudflare.com/workers/observability/traces/)
(`observability.traces.enabled`, beta). The runtime emits OTel-standard spans
for handler invocations, outbound fetches, and binding calls (D1, KV, R2,
Durable Objects, queues) with no SDK in the bundle; traces appear in the Workers
Observability dashboard next to Workers Logs, and `console.*` output inside a
span is attributed to that span. Custom spans are available via
`tracing.enterSpan()` from `cloudflare:workers` when application-level spans are
worth adding. App-level context rides on two hooks: every metered usage event
emits a `kody.usage.{eventType}` child span with `kody.user_id` and entity
attributes (see [usage-metering.md](./usage-metering.md)), and Sentry error
events carry the signed-in user id (id only, no PII) via `Sentry.setUser` in the
app auth resolver and the MCP failure reporter.

Production deploys additionally export these traces to Sentry through the
account-level `sentry-otlp-traces` destination; preview and test deploys inherit
the top-level block without a destination, so their spans stay in the Cloudflare
dashboard. The destination itself (endpoint, auth header, fork provisioning) is
documented in [setup-manifest.md](../setup-manifest.md), and the
`SENTRY_TRACES_SAMPLE_RATE` handling (production pins it to `0` to avoid
duplicate SDK traces) in
[environment-variables.md](../environment-variables.md).

Billing note: each span is one observability event sharing the Workers Logs
quota (10M events/month included on Workers Paid). Sampling is controlled by
`observability.traces.head_sampling_rate` (defaults to full sampling, fine at
current traffic).

### Browser errors and session replay

The client bundle initializes `@sentry/browser` from a `kody:sentry` meta tag
that `ssr-document.tsx` renders when `SENTRY_DSN` is configured (the DSN is a
publishable client key). Capture is errors plus **error-only Session Replay**:
`replaysSessionSampleRate` is `0` and `replaysOnErrorSampleRate` is `1`, so
nothing is recorded to Sentry unless an error occurs, and replays mask all text
and block all media (`packages/worker/client/sentry-client.ts`) because Kody
sessions contain personal content. Envelopes are sent through the same-origin
`POST /sentry-tunnel` route
(`packages/worker/src/app/handlers/sentry-tunnel.ts`), which only forwards
envelopes whose DSN matches the Worker's own `SENTRY_DSN` — this keeps the
first-party CSP at `connect-src 'self'`. The CSP allows `worker-src blob:` for
the replay compression Web Worker.

### Source maps

`packages/worker/wrangler.jsonc` sets
[`upload_source_maps`](https://developers.cloudflare.com/workers/wrangler/configuration/#source-maps),
and `npm run deploy` passes
`--outdir .wrangler/sentry-bundle --upload-source-maps` so the bundle + maps are
generated consistently. To symbolicate stack traces in **Sentry** (not only in
Cloudflare), configure
[Cloudflare source maps in Sentry](https://docs.sentry.io/platforms/javascript/guides/cloudflare/sourcemaps/):
add GitHub **repository variables** `SENTRY_ORG` and `SENTRY_PROJECT`, a
`SENTRY_AUTH_TOKEN` **secret** with release upload scopes, then CI runs
`npm run sentry:upload-sourcemaps` after deploy using the same **release** as
`APP_COMMIT_SHA`.
