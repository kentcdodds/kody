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
   (`/@username/packages/*`) execute author-supplied HTML/JS and intentionally
   do not use the first-party CSP. Do not "unify" the two.
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
   with `/@...` user-scope paths refused so a README can never point viewers at
   hosted package endpoints. Never render third-party markdown via an HTML
   string, `innerHTML`, or a markdown-to-HTML renderer.

## First-party HTTP security headers

`render()` attaches the header set in
`packages/worker/src/app/security-headers.ts` to every trusted HTML response
(login, signup, account pages, the OAuth consent screen, and the SPA shell):

- `Content-Security-Policy` with `script-src 'self'` (no inline scripts),
  `frame-ancestors 'none'`, `base-uri 'self'`, `object-src 'none'`,
  `form-action 'self'`, and same-origin `connect-src`. The client bundle loads
  as an external module, so this does not require inline scripts. `style-src`
  allows `'unsafe-inline'` because SSR-streamed styles arrive as inline
  `<style>` tags; style injection is far lower risk than script injection.
- `X-Frame-Options: DENY` plus `frame-ancestors 'none'` — stops clickjacking of
  the OAuth consent screen and account pages.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Strict-Transport-Security` (ignored by browsers over plain HTTP, enforced
  over HTTPS).

These headers are deliberately **not** applied to hosted package apps, which
need their own looser policies to run author-authored code.

## Auth rate limiting

Credential-accepting POST endpoints share one per-IP auth rate-limit bucket
(`auth:ip:<ip>`) backed by a D1 atomic limiter
(`packages/worker/src/app/rate-limit.ts`, default 10 requests per 60-second
window). The shared bucket means brute-force attempts cannot fan out across
parallel paths. Covered paths (`rateLimitedAuthPaths` in
`packages/worker/src/index.ts`):

- `POST /auth` (password login/signup)
- `POST /oauth/authorize` (inline OAuth login)
- `POST /password-reset` (reset request)
- `POST /password-reset/confirm` (reset confirmation)

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
  scoped by `userId` (`packages/worker/src/mcp/secrets/`).
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
  memory-hard KDF. Acceptable here; changing it requires a rehash-on-login
  migration.
- **No CSRF tokens.** State-changing requests are protected by `SameSite=Lax`
  cookies plus JSON `Content-Type` on mutating endpoints. Revisit if any
  mutating endpoint starts accepting cross-site form posts or `SameSite=None`.
