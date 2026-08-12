# Security

Security-relevant patterns in the Worker, and the reasoning behind them. This
doc is the authoritative record of what is protected, what is intentionally out
of scope, and the invariants future changes must not regress. See the 2026-05-01
and 2026-07-01 internal security audits for the underlying findings.

Kody is a single Cloudflare Workers app: a Remix 3 browser UI plus an
OAuth-protected MCP server. It is multi-user, so the overarching invariant is
that **every read/write path is scoped by `userId`** (see
[`AGENTS.md`](../../AGENTS.md)). Cross-user data sharing is a bug, not a
feature.

## Invariants for future agents (do not regress)

Read this list before touching auth, routing, response construction, or the
package-app surfaces:

1. **First-party HTML keeps its security headers.** All trusted account/auth
   pages must go through `render()` (`packages/worker/src/app/render.ts`), which
   applies `packages/worker/src/app/security-headers.ts`. Never add
   `'unsafe-inline'` to the CSP `script-src`.
2. **Untrusted surfaces stay off the strict CSP.** Hosted package apps
   (`https://{username}.<package-app host>/packages/*` in production, or
   `/@username/packages/*` when served inline) execute author-supplied HTML/JS
   and intentionally do not use the first-party CSP. Do not "unify" the two.
   Because they have no CSP backstop, their isolation comes from the origin they
   run on and the credentials they never receive — see invariant 9.
3. **Developer-only routes fail closed.** Anything that runs attacker-authored
   content or aids debugging must be gated behind `isNonProductionRuntime`
   (`packages/worker/src/app/deployment-env.ts`) so it is unreachable in
   production.
4. **Credential endpoints are rate limited.** Any new endpoint that accepts a
   password, token, or reset code must join the shared auth rate-limit bucket in
   `packages/worker/src/index.ts` (`rateLimitedAuthPaths`).
5. **New passwords go through the shared policy.** Use `getPasswordPolicyError`
   from `@kody-internal/shared/password-policy.ts` wherever a password is set.
6. **OAuth PKCE stays S256-only.** Keep the `getPkceValidationError` check in
   `oauth-handlers.ts` (reject `code_challenge_method` other than S256 when a
   challenge is present). Do not switch to the provider's `allowPlainPKCE`
   option — see the OAuth section below for why.
7. **Every data path is `userId`-scoped.** New D1 queries, Durable Object names,
   and Vectorize filters must include `userId`. Prefer parameterized SQL
   (`.prepare(...).bind(...)`); never interpolate user input into SQL.
8. **Untrusted markdown renders through the safe renderer only.** Community
   READMEs (and any future third-party-authored markdown shown on first-party
   pages) must go through `packages/worker/client/markdown-view.tsx`, which
   builds JSX from an allowlist of `marked` lexer tokens: raw HTML renders as
   escaped text, no resource-loading elements are ever emitted (images become
   links), and links are restricted to absolute `http:`/`https:`/`mailto:` URLs
   with `/@...` user-scope paths and `/packages/...` package-app mount paths
   refused on any host so a README can never point viewers at hosted package
   endpoints. Never render third-party markdown via an HTML string, `innerHTML`,
   or a markdown-to-HTML renderer.
9. **Package code never receives first-party credentials, and never executes on
   the app origin in production.** Every request handed to package code goes
   through `createPackageCodeRequest`
   (`packages/worker/src/app/handlers/package-app.ts`), which strips `Cookie`,
   `Authorization`, `Proxy-Authorization`, and every `X-Kody-*` header — for the
   forwarded HTTP request _and_ the realtime connect upgrade, because the
   realtime `connect` hook is handed the request headers too. Production also
   sets `PACKAGE_APP_BASE_URL` so package apps run on their own registrable
   domain, cross-site from the app origin. Do not add a first-party route to the
   package-app origin, and do not reintroduce cookie forwarding "just for
   convenience". See
   [Hosted package app origin isolation](#hosted-package-app-origin-isolation).
10. **CSRF protection is `SameSite=Lax` + JSON content types, not tokens.**
    Every mutating first-party endpoint must keep requiring a JSON
    `Content-Type` (which cross-site form posts cannot send) and the
    `kody_session` cookie must stay `SameSite=Lax`. Do not add a mutating
    endpoint that accepts `application/x-www-form-urlencoded` or
    `multipart/form-data` from the browser, and do not relax the cookie to
    `SameSite=None`, without adding CSRF tokens at the same time.

## First-party HTTP security headers

`render()` attaches the header set in
`packages/worker/src/app/security-headers.ts` to every trusted HTML response
(login, signup, account pages, the OAuth consent screen, and the SPA shell):

- `Content-Security-Policy` with `script-src 'self' https://cdn.usefathom.com`
  (no inline scripts; the Fathom Analytics tracker is the only allowed external
  script and its image beacon is also allowed in `img-src`),
  `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`,
  `form-action 'self'`, `worker-src 'self' blob:` (for Sentry Session Replay),
  and same-origin `connect-src`. The client bundle loads as an external module,
  so this does not require inline scripts. `style-src` allows `'unsafe-inline'`
  because SSR-streamed styles arrive as inline `<style>` tags; style injection
  is far lower risk than script injection.
- `X-Frame-Options: DENY` plus `frame-ancestors 'none'` — stops clickjacking of
  the OAuth consent screen and account pages.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Strict-Transport-Security` (ignored by browsers over plain HTTP, enforced
  over HTTPS).

These headers are deliberately **not** applied to hosted package apps, which
need their own looser policies to run author-authored code.

## Hosted package app origin isolation

Hosted package apps execute author-supplied HTML, JS, and worker code. In
production they run on per-user subdomains of the package-app domain
(`https://{username}.kodyapps.dev/packages/{kodyId}/...`); confirmed
non-production runtimes may serve them inline on the app origin at
`/@{username}/packages/{kodyId}/...` instead. Anything that shares an origin
with a package app is inside its reach, and package apps get no CSP backstop
(invariant 2), so the origin boundary _is_ the control.

**Threat model.** Author-supplied package code must not act as the owner, and
one user's package apps must not reach another user's browser state. If package
apps shared the app origin and the handler forwarded a clone of the original
request into the package worker, author code would have two ways to act as the
owner:

- server-side, the forwarded request would carry the owner's `kody_session`
  cookie (and any `Authorization` header), so package code could read it and
  replay it;
- client-side, a same-origin package page could
  `fetch('/account/secrets.json', { credentials: 'include' })` from author JS
  and read the owner's secrets or mutate their account.

If every user's package apps shared one origin on the package-app domain, one
owner's package could also read or plant cookies and call same-origin endpoints
for another owner's packages. That is a real vulnerability, not an accepted
risk. Three independent controls close it.

**1. Credential stripping (always on).** `createPackageCodeRequest` builds the
request package code sees without `Cookie`, `Authorization`,
`Proxy-Authorization`, or `X-Kody-*` headers. It is applied to the forwarded
HTTP request and to the realtime WebSocket upgrade, because
`PackageRealtimeSession`'s `connect` hook receives the upgrade request's
headers. This holds regardless of hosting mode, so local dev and preview are
covered too.

**2. A separate registrable domain (production).** `PACKAGE_APP_BASE_URL`
(production Worker var, `https://kodyapps.dev` — the apex; the deploy publishes
apex and wildcard **zone routes** on the runtime Worker for that host, never a
Workers custom domain in this zone — see
[`setup-manifest.md`](./setup-manifest.md)) makes package apps cross-site from
the app origin, so the `SameSite=Lax`, `HttpOnly` `kody_session` cookie never
attaches to them and cross-origin `fetch` from package pages has no CORS grant
(`withCors` only reflects same-origin, plus `/mcp`). It must stay a **separate
registrable domain**: a subdomain of the app origin would still be same-site for
cookie purposes. `getPackageAppBaseUrl` (`packages/worker/src/app-base-url.ts`)
resolves the apex origin, and `getAppBaseUrl` refuses to resolve the package-app
origin as the app origin so package runtime callbacks and first-party links
always point back at the app.

**3. Per-user subdomains (production).** Each owner's hosted apps are served
from `{username}.<package-app host>` (`buildPackageAppSubdomainOrigin` in
`packages/shared/src/public-urls.ts`), so browser state (cookies, storage,
`document` access) never crosses accounts. The username label in the hostname
must be a valid single DNS label: lowercase letters, digits, and hyphens only,
3–32 characters, alphanumeric edges (`dnsSafeUsernamePattern` in
`packages/shared/src/public-urls.ts`). Every username satisfies this shape —
underscores are rejected everywhere, and there is no lenient recognition tier
(decision 0017). Wildcard DNS still routes invalid or nested labels to the
Worker, so hostnames that are not exactly one valid username label fail closed
with `404`.

Dispatch lives in `packages/worker/src/app/package-app-origin.ts`, called first
in the Worker `fetch` handler:

- **App origin, `/@{username}/packages/*`:** never executes package code. Safe
  methods redirect (`302`) to the owner's package-app subdomain with a handoff
  token; other methods get a `307` to that subdomain. Unauthenticated visitors
  are sent to `/login` on the app origin first.
- **Package-app apex** (`kodyapps.dev`): serves no package code. `/` redirects
  to the app origin. Legacy path-based URLs (`/@{username}/packages/*`) redirect
  (`302`/`307`) to the owning user's subdomain. Everything else — including
  `/account/*`, `/login`, `/mcp`, and the
  `/@{username}/api/package-invocations/*`, `/connectors/*`, `/webhooks/*`
  machine APIs — is `404`. Those APIs stay on the app origin on purpose: they
  are authenticated by their own bearer tokens or URL secrets, they are never
  called by package browser code, and hosting them on the package-app domain
  would only widen its surface.
- **Per-user package-app subdomain** (`{username}.kodyapps.dev`): serves only
  `/packages/{kodyId}/*` for that hostname's username label. `/` redirects to
  the app origin; every other path is `404`.

**Handoff session and fixation defense.** The app origin mints a short-lived
single-use handoff token; the owner's subdomain exchanges it for a host-scoped
package-app session cookie (`packages/worker/src/app/package-app-session.ts`).
On secure requests the cookie is named `__Host-kody_pkg_session`; plain HTTP
local dev uses `kody_pkg_session` because browsers refuse `__Host-` cookies on
insecure origins. The `__Host-` prefix requires `Secure`, `Path=/`, and no
`Domain` attribute, so browsers reject any variant with a `Domain` — this blocks
cross-subdomain cookie tossing even before the package-app domain is on the
Public Suffix List. Serving additionally requires the resolved session account's
username, the subdomain label, and the path's owner username to all match
(`servePackageAppRequest` in
`packages/worker/src/package-runtime/package-app-serve.ts`), so a handoff minted
for one account cannot authorize another user's subdomain.

Sibling subdomains also stay **same-site** with each other until the domain is
on the Public Suffix List, so a `SameSite=Lax` cookie still attaches to their
cross-origin requests. In a browser holding sessions for two accounts (a shared
machine), one user's package code could otherwise send a credentialed mutating
request to the other user's app — CORS blocks the response, not the side effect.
Mutating requests on a subdomain therefore require any `Origin` header to match
the subdomain itself; requests without one (non-browser clients, synthetic
dispatch) authenticate through their own paths. Same-site credentialed GETs
remain possible until the PSL entry lands; package apps must not mutate on GET,
which HTTP already demands.

- **No redirect cycle:** the app origin only ever redirects _to_ a package-app
  subdomain, the apex only redirects to a subdomain or the app origin, and a
  subdomain only redirects within itself to drop a consumed token from the URL
  (plus its bare `/`, which goes home to the app origin — a terminal hop, not
  part of the handoff). A package-app request with no usable session terminates
  in a `403` that links back to the app origin, so a browser that refuses the
  cookie fails visibly instead of ping-ponging between hosts.

Production fails closed with `500` before executing package code when
`PACKAGE_APP_BASE_URL` is missing, invalid, equal to `APP_BASE_URL`, or on the
same registrable domain. There is no production inline fallback.

Preview, tests, E2E, and `npm run dev` may keep serving package apps inline when
no package-app origin resolves. That path is still credential-stripped, but it
is same-origin, so **do not treat a non-production inline run as representative
of the production isolation boundary**. To exercise the two-origin flow locally,
set `PACKAGE_APP_BASE_URL=http://packages.localhost:<port>` in
`packages/worker/.env`.

The cross-site handoff (how the owner is recognized on the package-app subdomain
without giving package code a first-party session) is documented in
[`architecture/authentication.md`](./architecture/authentication.md#package-app-origin-handoff).

Because hosted package apps are served from this deployment's own origins, code
that decides whether a URL is "ours" must accept every production shape.
`parsePackageSearchIdentity`
(`packages/worker/src/mcp/tools/package-search-identity.ts`) accepts a
`https://{username}.<package-app host>/packages/{kodyId}` URL, a
`/@{username}/packages/{kodyId}` URL on the app or package-app apex, and
`/account/packages/{packageId}` on the app origin — so a URL copied out of a
running package app resolves to that package — while other `/account/*` paths
stay app-origin only. Untrusted markdown is the opposite case:
`getSafeMarkdownLinkHref` refuses any `/@...` user-scope path and any
`/packages/...` package-app mount path regardless of host, so a community README
cannot link into either origin's package surface.

**Out of scope (deliberate).** User-to-user isolation is complete: each owner's
apps run on a distinct origin. Two packages owned by the **same** user still
share that user's subdomain origin, so one of that owner's package apps can
reach another's `__Host-kody_pkg_session`-authorized endpoints from the browser.
That is a smaller blast radius than first-party access (all of it stays inside
one owner's own data, since serving is `userId`-scoped and the session is bound
to one account), but it is not zero.

**Operational follow-up (not code).** Submit `kodyapps.dev` to the
[Public Suffix List](https://publicsuffix.org/submit/) for defense-in-depth
(sibling subdomains treated as separate registrable domains by browsers). That
requires a `_psl` TXT record on the zone and a PR to
[publicsuffix/list](https://github.com/publicsuffix/list) by the domain owner.
The `__Host-` cookie is the primary cookie-tossing control; PSL entry is an
additional layer.

## Auth rate limiting

Credential-accepting POST endpoints share one per-IP auth rate-limit bucket
(`auth:ip:<ip>`, `packages/worker/src/app/rate-limit.ts`, default 10 requests
per 60-second window). Deployed environments use the Cloudflare rate-limit
binding (`AUTH_RATE_LIMITER` in `packages/worker/wrangler.jsonc`); local dev,
tests, and self-hosted configs fall back to a D1 atomic limiter. Production
fails closed: env validation (`packages/worker/src/app/env.ts`) rejects a
production runtime without the binding, so the D1 fallback can never silently
become the production limiter. The shared bucket means brute-force attempts
cannot fan out across parallel paths. Covered paths (`rateLimitedAuthPaths` in
`packages/worker/src/index.ts`):

- `POST /auth` (password login/signup)
- `POST /auth/github`, `POST /auth/google`, `POST /auth/x` (social login start)
- `POST /oauth/authorize` (inline OAuth login)
- `POST /password-reset` (reset request)
- `POST /password-reset/confirm` (reset confirmation)
- `POST /verify/2fa.json` and `POST /account/two-factor.json` (two-factor)
- `POST /webauthn/authentication` (passkey authentication)

Excess requests receive `429 Too Many Requests` with a `Retry-After` header. The
D1 approach uses a batched INSERT + COUNT in a single transaction, avoiding the
read-then-write race that KV-backed limiters suffer under concurrency.

## Password policy

Signup and password-reset confirmation enforce a minimum password length via
`@kody-internal/shared/password-policy.ts`. The server is the trust boundary;
the browser hint is advisory. Login does not re-check length, so existing
accounts are never locked out.

## OAuth / MCP hardening

- PKCE is validated at the application layer: `getPkceValidationError`
  (`packages/worker/src/oauth-handlers.ts`) rejects an authorize request whose
  `code_challenge_method` is anything other than `S256` when a `code_challenge`
  is present. Plain PKCE offers no protection against code interception. We do
  **not** use the provider's `allowPlainPKCE: false` option because, in this
  provider version, it rejects every authorize request that lacks an explicit
  `code_challenge_method=S256` — including legitimate confidential-client flows
  that use no PKCE at all — which breaks real MCP clients.
- Dynamic client registration (`/oauth/register`) is intentionally **open**: the
  MCP OAuth spec requires it, and clients (including native/public clients using
  PKCE) rely on it. This is a deliberate acceptance, not a gap. Do not add
  `disallowPublicClientRegistration` without a plan for how MCP clients
  register.
- `/mcp` requires a bearer token whose audience matches the origin
  (`packages/worker/src/mcp-auth.ts`).

## MCP denial visibility

MCP authentication and authorization denials are recorded in `audit_events`
(`category: 'auth'`, `result: 'failure'`) via `recordMcpAuthDenial`
(`packages/worker/src/mcp/auth-audit.ts`), not in Sentry. A single denial is a
routine agent turn, so it is not an error; a burst from one principal is how
permission probing or a compromised account would look, and the audit log is the
surface built for that — hashed identifiers, 180-day retention, an admin-only
query (`admin_audit_log_query`), and the failure-per-day and failure-per-hour
charts on `/admin/insights`. Two sites record:

- `handleMcpRequest` rejecting a resolved grant (`mcp_token_rejected`):
  unidentifiable grant, unverified email, suspended account.
- `assertCallerCanAccessCapability` refusing a capability
  (`mcp_capability_denied`): missing user, role, permission, or feature flag.
  This is the single choke point every capability call passes through, so it
  covers the whole authorization surface.

An hourly cron lane (`auth_denial_alert` in `packages/worker/src/index.ts`,
implemented by `checkAuthDenialBurstAndNotify` in
`packages/worker/src/app/auth-denial-alerts.ts`) emails every admin account when
MCP auth denials in the last 60 minutes cross a threshold (default 50). A KV
cooldown prevents re-paging on the same sustained spike. Charts on
`/admin/insights` remain the browse surface; the email is the page.

A second hourly lane (`email_delivery_alert`, implemented by
`checkEmailDeliveryBurstAndNotify` in
`packages/worker/src/app/email-delivery-alerts.ts`) pages admins when
platform-wide Cloudflare Email Sending outcomes of `complained` or `bounced` in
the last 60 minutes cross a threshold (default 20). Those match the
outbound-abuse reputation signals (`failed` / `rejected` are not counted).
Cooldown is 6 hours via `BUNDLE_ARTIFACTS_KV`. This complements the per-user
outbound pause in `outbound-abuse.ts` — that path stops one account; the cron
pages when the shared sending domain is under platform-wide pressure. Review the
Email delivery health chart on `/admin/insights`.

**Deliberately not recorded:** rejections that happen before a grant resolves —
a missing, empty, or unparseable bearer token. Those are reachable by any
anonymous request, so auditing them would let a stranger drive unbounded D1
writes, and "someone sent a bad token" is not attributable to a principal. The
consequence is that **brute-forcing or replaying tokens against `/mcp` does not
appear in the audit log**; flood control for anonymous traffic belongs at the
edge (Cloudflare rate limiting / WAF), not in application writes.

## Public connector routes are WebSocket-only

The Worker entrypoint (`packages/worker/src/index.ts`) only forwards user-scoped
connector route requests (`/@{username}/connectors/{kind}/{instanceId}`) when
the request carries a `WebSocket` upgrade header. Non-upgrade HTTP requests and
unmatched `/connectors/*` paths are rejected with `404` before reaching static
assets or the Durable Object.

As a second layer, the remote connector session Durable Object `fetch()` handler
rejects all non-WebSocket requests with `404`. Worker-internal callers use
Durable Object RPC methods (`getSnapshot()`, `rpcListTools()`, `rpcCallTool()`)
directly on the stub, bypassing `fetch()` entirely.

## Maintenance route guard

Any `/__maintenance/*` path that does not match a known handler returns `404`
with a JSON body. This prevents unhandled maintenance paths from falling through
to the SPA shell and silently returning `200 OK`. Known maintenance handlers are
guarded by a bearer secret comparison.

## Secrets and user code execution (in-scope model)

- Saved secrets are encrypted at rest with AES-GCM under `SECRET_STORE_KEY` and
  scoped by `userId` (`packages/worker/src/mcp/secrets/`). Ciphertexts are
  versioned (`v2.<iv>.<ct>`) and bound via AES-GCM additional authenticated data
  to their purpose and owning identity (`user:<userId>` for user secrets,
  `app:<slug>` for platform OAuth client secrets), so a ciphertext copied into
  another user's row fails to decrypt. Legacy unversioned ciphertexts still
  decrypt and upgrade to `v2` whenever the value is re-encrypted on write. Only
  `v2` provides owner binding: a legacy ciphertext carries no AAD, so until it
  is rewritten it would still decrypt if copied into another row (metadata-only
  writes preserve the legacy ciphertext). Row swaps already require write access
  to the database, so this is defense-in-depth, not a standing hole; the
  compatibility branch is deliberately upgrade-on-write (never rewrite-on-read)
  and gets removed once no legacy ciphertexts remain.
- `SECRET_STORE_KEY` is escrowed for disaster recovery as a passphrase-sealed
  blob in the DR backup bucket (solo operator; see
  [Disaster recovery](./disaster-recovery.md) and
  [Secret rotation](./secret-rotation.md)). The plaintext key must not appear in
  backup SQL, manifests, or repository files.
- Outbound secret use goes through the fetch gateway
  (`packages/worker/src/mcp/fetch-gateway.ts`), which is deny-by-default: a
  secret placeholder is only substituted for a host the user explicitly approved
  in the account UI. Policy writes (allowed hosts/capabilities/packages) are
  only reachable through the authenticated account UI.
- User code runs in a Cloudflare Worker Loader isolate without the parent `env`;
  capabilities are RPC'd back to handlers that enforce the caller's `userId`.
- The DR control-plane Admin UI is protected by Cloudflare Access plus in-worker
  `Cf-Access-Jwt-Assertion` verification; production restore is a graduated
  prepare → typed confirmation → Workflow path, never a single click.

## Inbound email spam controls

Inbound mail is classified at receive time (`accepted` or `quarantined`) before
package subscription dispatch. Per-user sender rules run first (exact address or
domain with subdomain matching; address rules beat domain rules): `block`
rejects at SMTP before quota is charged, `quarantine` stores as flagged, `allow`
bypasses the auth-verdict quarantine. When no rule matches, Kody parses
Authentication-Results (DMARC fail, or SPF fail/softfail without DKIM pass →
quarantine; missing header fails open). Accepted user mail dispatches
`email.message.received`; quarantined user mail dispatches
`email.message.quarantined` instead. Quarantined operator system-inbox mail is
stored but suppresses `email.system-message.received`. Reclassification never
retroactively fires subscription events. Users manage rules via
`email_sender_rule_*` (200-rule cap) and reclassify via `email_message_classify`
or `/account/email`; operators use `admin_system_email_sender_rule_*` for system
inboxes. Upstream, Cloudflare Email Routing already rejects mail failing both
SPF and DKIM and honors sender DMARC policy.

## Abuse controls (suspension, email pause, compute quotas)

One bad actor can poison shared platform identity — every user sends mail from
one platform domain through one Cloudflare Email Sending account, and every
sandbox fetch leaves through the same Worker egress. Three controls bound that
blast radius:

- **Platform suspension (`users.suspended_at`).** An admin-set kill switch,
  distinct from a community ban (which only blocks community-surface actions).
  Enforced fail-closed at every chokepoint: browser session resolution
  (`readAuthenticatedAppUser` / `loadSessionInfo` treat a suspended session as
  signed out), MCP bearer auth (`handleMcpRequest` returns a 403
  `account_suspended` response, mirroring the email-verification gate), and both
  email directions (inbound storage rejects with a bounded `account-suspension`
  rejection event; outbound send throws). Set and cleared through the audited
  `suspend_user` / `unsuspend_user` actions on `POST /admin/users.json`.
- **Automatic outbound-email pause (`users.email_outbound_paused_at`).** The
  delivery queue evaluates provider delivery events
  (`packages/worker/src/email/outbound-abuse.ts`): one spam complaint, or five
  or more bounced sends within a UTC day, pauses that account's outbound email
  and notifies admin accounts through the transactional sender. The pause write
  is idempotent (only transitions NULL), the send path rejects while paused, and
  the audited `resume_email_outbound` admin action clears it after review. The
  `/admin/insights` "Email delivery health" chart shows platform-wide outcome
  trends so reputation trouble is visible before providers act on it. The hourly
  `email_delivery_alert` cron pages admins on a platform-wide burst (see above)
  without replacing this per-user pause.
- **Compute quotas.** `execute_calls_per_day` and `outbound_fetches_per_day`
  entitlements bound sandbox compute and egress volume per user per day (see
  [`architecture/entitlements.md`](./architecture/entitlements.md)).

## Accepted residual risks and out-of-scope items

These were reviewed and intentionally left as-is for this project. Document any
change to these decisions here so future agents do not relitigate them.

- **Stateless sessions revoke after password reset.** `kody_session` is a signed
  cookie with no server store, so there is no global "log out everywhere"
  button. Password reset confirmation stamps `users.password_changed_at` and
  every browser session carries `issuedAt`; `resolveRequestAuth` rejects cookies
  issued at or before that timestamp (missing `issuedAt` fails closed once a
  password change exists). A future hardening could add an explicit "sign out
  other sessions" control without waiting for a reset.
- **Account secret reveal is owner-scoped, not password-reauthenticated.** See
  the "Account secret reveal" section of
  [`architecture/authentication.md`](./architecture/authentication.md).
- **`refreshAccessToken` materializes plaintext OAuth tokens** inside user code
  for integration calls. Prefer `createAuthenticatedFetch`, which enforces the
  integration host allowlist. This is documented at the call site
  (`packages/worker/src/mcp/execute-modules/kody-runtime-utils.ts`).
- **Sandbox `fetch` has no general SSRF denylist.** Secret-bearing requests are
  constrained by per-secret host allowlists; non-secret requests rely on the
  Cloudflare Workers platform egress model.
- **PBKDF2-SHA256 (100k iterations)** is used for password hashing rather than a
  memory-hard KDF. Workers' WebCrypto has no argon2/scrypt, and Cloudflare's
  production runtime rejects PBKDF2 above 100,000 iterations (deriveBits throws
  `NotSupportedError`; local workerd does not enforce the cap), so 100k is the
  strongest setting the platform allows — below OWASP's 600k PBKDF2-SHA256
  guidance. Iteration counts above the runtime cap are rejected during
  verification (they could never derive in production), and lower-iteration
  hashes are transparently re-hashed after a successful login
  (`packages/worker/src/password-upgrade.ts`), so the setting can be raised
  without a migration if the platform cap ever lifts.
- **No CSRF tokens.** State-changing requests are protected by `SameSite=Lax`
  cookies plus JSON `Content-Type` on mutating endpoints. This is a deliberate
  decision, restated as invariant 10 above: it holds only while both halves
  hold, so revisit if any mutating endpoint starts accepting cross-site form
  posts or `SameSite=None`.
