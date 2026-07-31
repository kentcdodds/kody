# Authentication

`kody` is multi-user. Each signed-in user has a fully isolated assistant: their
own packages, jobs, secrets, values, memories, remote connectors, email inboxes,
and durable storage. The auth layer is the boundary that establishes which user
a request belongs to before any handler reads or writes data.

`kody` uses two related authentication models:

1. Cookie-based app sessions for browser users
2. OAuth bearer tokens for MCP access

Hosted package apps are served from a separate origin in production and use a
third, deliberately narrow credential — see
[Package app origin handoff](#package-app-origin-handoff).

Authorization (roles and permissions) is layered on top of authentication. See
[Authorization](./authorization.md) for the RBAC model, admin routes, and the
`any`-access exception for account administration.

## Browser app sessions

Session cookie behavior is implemented in
`packages/worker/src/app/auth-session.ts`.

- Cookie name: `kody_session`
- `httpOnly: true`
- `sameSite: 'Lax'`
- signed with `COOKIE_SECRET`
- default max age: 7 days
- `remember me` login max age: 30 days
- remembered sessions are renewed with a fresh 30-day cookie after 14 days of
  age

The cookie payload stores:

- `v: 2`
- `stableUserId` (the authoritative `users.stable_user_id`)
- `email`
- `issuedAt` (epoch ms when the cookie was issued or last renewed)
- `rememberMe` when the login used remember-me

Password reset confirmation writes `users.password_changed_at`. Session
resolution rejects cookies whose `issuedAt` is missing or at/before that
timestamp, so a reset invalidates every existing browser session.

`users.id` never crosses the cookie boundary. Session resolution looks up the
stable id and only then uses the numeric primary key for internal D1 joins.
Version-1 cookies fail closed and require a fresh login.

`packages/worker/src/app/handler.ts` calls `setAuthSessionSecret` on each
request so cookie signing and verification are available to handlers.

## Login and signup

`POST /auth` is implemented by `packages/worker/src/app/handlers/auth.ts`.

- Accepts JSON body with `email`, `password`, `mode` (`login` or `signup`), an
  optional `inviteCode` for signups, and optional `rememberMe` for logins
- Uses D1 (`users` table) for user lookups and inserts
- Hashes passwords with `@kody-internal/shared/password-hash.ts`
- Returns signed session cookie via `Set-Cookie` on success
- Emits structured audit events through `packages/worker/src/audit-log.ts`

### Signup posture and invites

Production signup is invite-gated. The auth handler uses
`packages/worker/src/app/deployment-env.ts` (`isNonProductionRuntime`) to decide
whether an invite is required. Production wrangler env sets
`SENTRY_ENVIRONMENT: 'production'`; `npm run dev` sets
`WRANGLER_IS_LOCAL_DEV=true`; preview/test set `SENTRY_ENVIRONMENT` to
`'preview'` / `'test'`. The predicate fails closed: if the runtime cannot be
positively identified as non-production, signup requires a valid invite code.

The public `/signup` page defaults to a waiting-list form (first name + email)
backed by `POST /waiting-list`, which upserts a Kit subscriber and tags them
`waitlist::kody`. An "I have a code" control reveals the invite signup form.
`?code`, `?invite`, or `?panel=invite` also opens the invite form directly.

Waiting-list Kit integration:

- Worker secret `KIT_API_KEY` (Kit v4 `X-Kit-Api-Key`)
- Optional `KIT_WAITLIST_TAG_ID` (defaults to the `waitlist::kody` tag id)
- Optional `KIT_WAITLIST_SEQUENCE_ID` (defaults to the "Kody Waitlist Welcome"
  sequence, which sends an immediate thank-you from `hello@kentcdodds.com`
  asking what they hope to use Kody for)
- Production fails closed with 503 when `KIT_API_KEY` is unset; non-production
  accepts the join without calling Kit so local/preview UX stays usable. Preview
  deploys intentionally omit `KIT_API_KEY` so they never write to the production
  Kit audience.
- Existing Kit subscribers are tagged/enrolled without overwriting their
  `first_name`
- Rate-limited per client IP (5 requests / 15 minutes)

Account signup Kit tagging (password and OAuth signup):

- When `KIT_API_KEY` is set and the new account email already exists in Kit,
  apply `signed_up::kody` (optional override `KIT_SIGNED_UP_TAG_ID`)
- Does not create Kit subscribers for people who were never on the list
- Leaves existing tags alone (including `waitlist::kody`)
- Best-effort only: Kit errors or a missing key never fail account creation

The `invites` table stores operator-created invite codes:

- `code` is the primary key shown to the invited user
- `created_by` references the admin account that created it (nullable so account
  deletion does not strand invites)
- `note`, `max_uses`, `use_count`, `expires_at`, `revoked_at`, and `created_at`
  describe current invite state
- `plan` (NOT NULL; DDL DEFAULT `'free'` after `0083-plan-default-free.sql`;
  added by `0065-invite-plans.sql`; stored `'unlimited'` renamed to `'max'` by
  `0082-rename-unlimited-plan-to-max.sql`; migration-window residual
  `'unlimited'` reconciled to `'max'` by `0083-plan-default-free.sql`) is an
  optional signup plan name; password and social signup read the consumed
  invite's stored plan with `parseStoredPlanName` and copy it onto `users.plan`
  via `resolvePlanWrite`. Omitted invite plans are written as `free`. Admin
  invite creation validates plan names with strict `parsePlanName`. See
  [Entitlements](./entitlements.md).

Production signup atomically consumes an invite with a single conditional
`UPDATE ... WHERE use_count < max_uses AND revoked_at IS NULL ...`; concurrent
requests cannot over-use a code. Local dev, preview, and test runtimes remain
open when no invite is supplied, but they still consume and validate an invite
when a code is provided so E2E coverage can exercise the same path.

Admins manage invites at `/admin/invites`. The route uses the RBAC `admin` role
guard, not an owner-scoped content bypass. Invite creation (including optional
plan), use, and revocation emit audit events.

The same admin page can create a user directly by email for manually invited
people. That flow calls `adminCreateUserWithPasswordSetup` in
`packages/worker/src/identity/admin-user-creation.ts` instead of going through
the web route logic directly, so future admin MCP capabilities can reuse the
same service. It:

- requires a unique email and either a unique explicit username or an
  auto-generated unique username derived from the email
- stores a sentinel `password_hash` that never verifies as a usable password
- marks `users.email_verified_at` immediately because the admin knows the
  recipient
- creates a `password_resets` token with a 7-day expiry and returns the
  `/reset-password?token=...` setup link to the admin UI
- never sends email automatically; the operator copies the displayed setup link
  into a manual email

There is no privileged "primary user" at runtime. The first admin is still
bootstrapped through SQL; after that, admin role assignment and invite
management happen through admin routes.

### Email verification

New signups create an `email_verifications` token row, send a verification link
through `packages/worker/src/app/email/cloudflare-email.ts`, and store
`users.email_verified_at` only after `GET /verify-email?token=...` succeeds.
Verification tokens expire after 24 hours and only token hashes are stored.

Signup fails hard when the verification email cannot be sent: the created user
row is rolled back and any consumed invite use is released, so the
email/username can be retried. An account must never exist without a way to
verify it. The only exception is non-production runtimes (local dev, preview,
test — see `isNonProductionRuntime`) with no Cloudflare email sender configured;
there the send is skipped and accounts are verified through seeded tokens
instead.

Signed-in users with an unverified email can request a fresh link with
`POST /account/resend-verification.json`
(`packages/worker/src/app/handlers/account-resend-verification.ts`), surfaced as
a "Resend verification email" button on `/pending-verification`, `/account`,
`/onboarding`, and `/oauth/authorize`. The endpoint reuses
`createEmailVerification` (invalidating older tokens) and is rate-limited per
user (3 requests per 15 minutes).

`users.email_verified_at` records whether an account's email is verified.
Accounts with a non-null value are treated as verified; normal signup leaves it
null until `GET /verify-email?token=...` succeeds. Seeded and test fixture
accounts are created verified. Unverified accounts can sign in and see their
status on `/account`.

Unverified accounts can still use browser sessions (sign in, manage account,
resend verification), but they must verify before MCP OAuth authorization or
assistant features:

- **Signup**: password signup keeps the authenticated session and lands on
  `/pending-verification` (preserving a safe `redirectTo` such as an OAuth
  authorize URL). Users can resend the verification email and continue once the
  link succeeds; continue returns to `redirectTo` when present, otherwise
  `/onboarding`.
- **Onboarding** (`/onboarding`): verified users only. Unverified HTML requests
  redirect to `/pending-verification`. Loader/API data still exposes
  `emailVerified` and withholds MCP URL/setup until verified as defense in
  depth. `needsOnboarding` means incomplete overall setup (`!emailVerified` or
  no MCP grant). Account keeps an inline verification card for resend/status;
  home and account banners do not show the connect-agent callout while
  unverified.
- **MCP OAuth authorize**: `/oauth/authorize` rejects approval before creating a
  grant/token when the account email is unverified
  (`403 email_verification_required`). The authorize UI keeps inline
  verification/resend controls and the original OAuth query so verification in
  another tab can resume without restarting the host connection.
- **MCP requests**: `handleMcpRequest` in `packages/worker/src/mcp-auth.ts` is
  the single chokepoint for `/mcp`. After token validation it checks
  `users.email_verified_at` (via `isAccountEmailVerified`) and rejects
  unverified — or unidentifiable — accounts with a
  `403 email_verification_required` JSON response pointing at `/account`. The
  gate fails closed: when verification cannot be established, the request is
  rejected.
- **Inbound email**: `handleInboundEmail` in
  `packages/worker/src/email/inbound.ts` rejects routed mail for unverified
  accounts right after username routing (`setReject` plus a bounded `rejected`
  email delivery event); nothing is stored.

Platform suspension (`users.suspended_at`, set by admins from `/admin/users`)
follows the same chokepoint pattern and also fails closed: browser session
resolution treats a suspended session as signed out (`readAuthenticatedAppUser`
/ `loadSessionInfo`), `handleMcpRequest` rejects with a `403 account_suspended`
JSON response after the verification gate, and both email directions reject
(inbound with a bounded `account-suspension` rejection event, outbound with an
error). See the "Abuse controls" section of [`security.md`](../security.md).

- **Email capabilities**: every capability in the MCP `email` domain calls
  `requireVerifiedEmailAccountUser`
  (`packages/worker/src/mcp/capabilities/email/require-verified-user.ts`) as
  defense-in-depth for callers that do not pass through `/mcp` (execute runtime,
  package jobs). Outbound sending additionally re-checks the account inside
  `packages/worker/src/email/outbound.ts` before sending from the
  platform-assigned `{username}@<platform domain>` sender address.

### Password policy

New passwords (signup and password-reset confirmation) must satisfy the
server-side policy in `@kody-internal/shared/password-policy.ts`
(`minPasswordLength`, 8). The server is the trust boundary; the browser hint is
advisory only. Login does **not** re-check length so pre-existing accounts are
never locked out.

## Two-factor authentication and passkeys

Both are opt-in and adapted from the Epic Stack.

**TOTP two-factor** (`packages/worker/src/app/two-factor.ts`):

- The `verifications` table (Epic Stack shape: `type` + `target` with TOTP
  config) stores secrets. An active row with `type = '2fa'` and
  `target = <db user id>` is the "two-factor enabled" flag; a `2fa-verify` row
  holds a pending setup that only activates once the user confirms a generated
  code at `/account/two-factor` (managed by
  `packages/worker/src/app/handlers/account-two-factor.ts`).
- When a 2FA account logs in with a password (or social login), the handler does
  **not** issue `kody_session`. It sets the short-lived signed `kody_verify`
  cookie (`packages/worker/src/app/verify-session.ts`, 10 minutes) and the
  client redirects to `/verify`. `POST /verify/2fa.json`
  (`packages/worker/src/app/handlers/verify.ts`) checks the TOTP code and only
  then issues the real session cookie. Passkey sign-in skips this step: a
  verified WebAuthn assertion already requires possession of the authenticator
  plus user verification (biometric/PIN), so it is treated as MFA-complete.
- Disabling 2FA requires a fresh code. The inline OAuth password form
  (`packages/worker/src/oauth-handlers.ts`) rejects 2FA accounts and directs
  them to establish a browser session first, since that flow has no TOTP step.

**Passkeys / WebAuthn** (`packages/worker/src/app/webauthn.ts`,
`packages/worker/src/app/passkeys.ts`):

- Registration and authentication ceremonies live in
  `packages/worker/src/app/handlers/webauthn.ts` using `@simplewebauthn/server`;
  challenges ride in the short-lived signed `kody_webauthn_challenge` cookie, so
  no server-side ceremony state exists.
- The relying party id/origin derive from the request host. WebAuthn requires a
  registrable domain, so Playwright passkey tests navigate via `localhost`
  rather than `127.0.0.1`.
- Passkeys are stored per user in the `passkeys` table and managed at
  `/account/passkeys`. Passkey sign-in is MFA-complete on its own
  (`userVerification: 'required'`): accounts with TOTP enabled go straight to a
  session and do not visit `/verify`.
- `POST /verify/2fa.json`, `POST /account/two-factor.json`, and
  `POST /webauthn/authentication` share the per-IP auth rate-limit bucket with
  the other credential-accepting endpoints (`packages/worker/src/index.ts`).
- Re-enrolling a new authenticator while two-factor is active is rejected; users
  must disable first (which requires a current code), so a hijacked session
  cannot silently swap the second factor.
- Known limitation: sessions are stateless signed cookies, so enabling
  two-factor (like changing a password) cannot revoke session cookies issued
  earlier; they stay valid until they expire. Starting a new login does clear
  that browser's session cookie while the second factor is pending.

## Account deletion

`POST /account/delete` is implemented by
`packages/worker/src/app/handlers/account-delete.ts` and orchestrated by
`packages/worker/src/app/account-deletion.ts`.

- Requires an active `kody_session` cookie and a JSON body with `password`
  re-authenticating the current user; failures emit an audit event with
  `action: 'account_delete'`, `result: 'failure'`.
- On success, runs a full per-user cascade across:
  - all `user_id`-scoped D1 tables (children before parents),
  - the shared Vectorize capability index, removing memory, job and
    saved-package entries by id,
  - `BUNDLE_ARTIFACTS_KV` keys captured from `published_bundle_artifacts` and
    `archived_job_artifacts`,
  - the user's `StorageRunner` Durable Objects via the user-scoped
    `storageRunnerRpc` stub,
  - all OAuth grants for the user via the bound OAuth provider,
  - the user row itself last so a partial failure can be retried.
- Returns a structured
  `{ ok, deletedRowCounts, deletedKvKeys, revokedOAuthGrants, clearedDurableObjects, deletedVectors, warnings }`
  payload alongside a `Set-Cookie` that destroys the session.

Related handlers:

- `GET /login` and `GET /signup`:
  `packages/worker/src/app/handlers/auth-page.ts`
- `POST /logout`: `packages/worker/src/app/handlers/logout.ts`
- `POST /session`: `packages/worker/src/app/handlers/session.ts` for session
  status checks
- `GET /account`: `packages/worker/src/app/handlers/account.ts` (redirects to
  login if missing session)

### Client session refresh behavior

The app shell (`packages/worker/client/app.tsx`) refreshes session state after
initial load and on client-side navigation events. Navigation-triggered
refreshes are throttled (30s) to avoid a `/session` round trip on every SPA
navigation, but the throttle never applies to refreshes that follow a mutation:
the client router (`packages/worker/client/client-router.tsx`) emits a
`mutation` event after every form POST it submits (exposed as
`listenToRouterMutations`), and the shell marks its session state stale so the
follow-up redirect navigation refreshes it regardless of the throttle —
auth-changing POSTs like `/logout` update the top nav immediately. If an
in-flight refresh is aborted, the client keeps the last known ready session
instead of overwriting it with `null`. This prevents transient logged-out UI
during concurrent re-renders.

## Password reset

Password reset handlers are in
`packages/worker/src/app/handlers/password-reset.ts`.

- `POST /password-reset` creates a one-time token and stores only its hash
- `POST /password-reset/confirm` verifies token hash and expiry, then updates
  password
- reset tokens expire after 1 hour
- when configured, email delivery is done via Cloudflare Email API
- when required Cloudflare Email API credentials are unset, the helper logs a
  redacted diagnostic without the email body or token URL to prevent token
  leakage in logs

## Package app origin handoff

Hosted package apps run on their own registrable domain in production
(`PACKAGE_APP_BASE_URL`) so author-supplied code is cross-site from the app
origin — see
[Hosted package app origin isolation](../security.md#hosted-package-app-origin-isolation)
for why. That means `kody_session` never reaches them, so the package-app origin
needs its own, deliberately smaller credential.

**Handoff token** (`packages/worker/src/app/package-app-handoff.ts`). When a
signed-in owner requests `/@{username}/packages/{kodyId}/...` on the app origin,
the app origin mints `<base64url payload>.<HMAC-SHA256>`:

- signed with `COOKIE_SECRET` over a purpose-labelled message
  (`kody-package-app-handoff:v2`), so it is not interchangeable with any other
  signed value
- payload binds `{ stableUserId, username, kodyId, exp, jti }`; the package-app
  origin rejects a token whose `username`/`kodyId` do not match the requested
  path
- 60 second lifetime
- single use: `jti` is burned in `BUNDLE_ARTIFACTS_KV` for 60 seconds on first
  use. The burn happens **after** the path binding is checked, so a token
  presented on the wrong package path is refused without being consumed — a
  mistyped URL must not cost the owner a handoff they still hold. Replay
  protection is best effort (KV is eventually consistent) and is skipped when
  the binding is missing; signature, expiry, and the path binding always fail
  closed.

It travels in the `__kody_handoff` query parameter of a cross-origin redirect,
which is why it is deliberately this weak. A token in a URL is exposed to
browser history, referrers, and anything that logs URLs; the package-app origin
redirects straight to the same URL without it, which reduces that exposure but
cannot eliminate it. The 60-second expiry and the single-use burn are what bound
the damage when a token does leak. A request that still carries the parameter is
rewritten without it before package code sees it.

**Package-app session cookie**
(`packages/worker/src/app/package-app-session.ts`). Exchanging a valid token
sets `kody_pkg_session` on the package-app origin:

- `httpOnly: true`, `sameSite: 'Lax'`, `path: '/'`, `secure` per request
- 12 hour max age
- signed with a **derived** secret,
  `sha256Base64Url('kody-package-app-session:v2:' + COOKIE_SECRET)`, so a value
  signed for this cookie can never verify as a `kody_session`
- payload is `{ v, stableUserId, pkgUsername, issuedAt }` — a shape the app
  session schema rejects, so the two cannot be confused even by name
  substitution

It authorizes hosted package-app serving for one account and nothing else: the
app origin has no code path that reads it, and the package-app origin has no
first-party routes. Every request re-resolves the account from D1
(`resolvePackageAppOwnerByStableUserId`) and fails closed for unknown, deleting,
or suspended accounts, and for sessions issued at or before
`users.password_changed_at` — the same rules browser sessions follow. Confirmed
local, preview, and test runtimes with `PACKAGE_APP_BASE_URL` unset never mint
either credential; they serve package apps inline behind `kody_session`.
Production requires a separate registrable package-app origin and returns `500`
instead of falling back inline when that configuration is missing or unsafe.

## Account secret reveal

The account secrets API (`packages/worker/src/app/handlers/account-secrets.ts`)
returns a decrypted secret value to the **owner** only, and only for the
selected secret:

- `GET /account/secrets.json?selected=<secretId>` resolves the value into the
  `selectedSecret.value` field of the JSON payload
- Requires an active `kody_session` cookie; the value is scoped to the
  authenticated user's `mcpUser.userId`, so a session can only ever read its own
  secrets
- All responses set `Cache-Control: no-store`
- There is **no** separate `/account/secrets/reveal` endpoint and **no**
  password reauthentication step — revealing a secret is inside the owner's own
  trust boundary (same-origin, session-authenticated)

This is an intentional design decision, not an oversight. The exfiltration
concern (XSS or a stolen session reading the owner's secrets) is mitigated by:

- the strict first-party `Content-Security-Policy` (`script-src 'self'`, no
  inline scripts) plus `HttpOnly` + `SameSite=Lax` session cookies (see
  `docs/contributing/security.md`), which make script-injection theft hard
- decryption at rest and per-user scoping on every read

Residual risk: a stolen session cookie can read the owning user's own secrets
until it expires (sessions are stateless — see the "Accepted residual risks"
section of `docs/contributing/security.md`). If a future change needs a stronger
control, the recommended approach is a password-reauthenticated reveal endpoint
combined with server-side session invalidation. Do not silently reintroduce
plaintext reveal without also considering that hardening.

## Social login (GitHub / Google / X)

Kody can act as an OAuth 2.0 client of GitHub, Google, and X for browser
sign-in. Provider identities live in the `oauth_connections` table; handlers
live in `packages/worker/src/app/handlers/auth-provider.ts` with the provider
definitions in `packages/worker/src/app/oauth-providers.ts`.

- `POST /auth/:provider` starts the flow (CSRF state + PKCE verifier + optional
  invite code in the signed `kody_oauth_login` cookie);
  `GET /auth/:provider/callback` completes it and issues the normal
  `kody_session` cookie. The first-party UI fetches the start endpoint with
  `Accept: application/json` and navigates to the returned authorize URL itself,
  because the CSP locks `form-action` and `connect-src` to `'self'`
- Existing connections sign in directly; the two-factor gate applies exactly as
  for password logins (passkey sign-in skips TOTP)
- A signed-in user hitting the callback links the provider identity to their
  account, managed from the `/account` "Connected accounts" card backed by
  `/account/connections.json` (disconnect is refused when the connection is the
  only sign-in method); a provider-verified email matching an existing account
  auto-links and signs in; otherwise account creation follows the signup posture
  (production requires a valid invite code carried from the invite signup panel;
  non-production remains open without one)
- Buttons only render for providers whose client id/secret env vars are set;
  `MOCK_`-prefixed client ids activate an in-worker mock flow on non-production
  runtimes for dev and E2E tests

Setup and operational details: `docs/contributing/social-login.md`.

## OAuth for MCP

OAuth endpoints are implemented in `packages/worker/src/oauth-handlers.ts` and
routed from `packages/worker/src/index.ts`.

- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token` (via provider)
- Client registration: `/oauth/register` (via provider)
- Supported scopes: `profile`, `email`
- On `/oauth/authorize`, unauthenticated users can log in inline or via top-nav
  auth links; those links preserve the full authorize URL in `redirectTo` so
  successful login returns to the original OAuth request. Password signup lands
  on `/pending-verification` with that safe `redirectTo` preserved for
  continue-after-verify. The authorize tab itself should stay open when the
  email link is opened elsewhere, so the original OAuth query remains resumable.
- Approval is rejected before `completeAuthorization` when the account email is
  unverified, so no grant/token is created until verification succeeds.

`/mcp` is protected by `packages/worker/src/mcp-auth.ts`:

- Requires `Authorization: Bearer <token>`
- Token is validated via OAuth provider helpers (`unwrapToken`)
- Audience must match the app origin or `<origin>/mcp`
- Unauthenticated requests return `401` with `WWW-Authenticate` metadata
- The account email must be verified; unverified accounts receive a
  `403 email_verification_required` response (see the email verification section
  above)

## What to read when changing auth

- `packages/worker/src/index.ts` for route order and integration points
- `packages/worker/src/oauth-handlers.ts` for OAuth authorization logic
- `packages/worker/src/mcp-auth.ts` for MCP token enforcement
- `packages/worker/src/app/auth-session.ts` for cookie format/signing
- `packages/worker/src/app/handlers/auth.ts` for app login/signup flow
- `packages/worker/src/app/invites.ts` and
  `packages/worker/src/app/handlers/admin-invites.ts` for invite management
- `packages/worker/src/identity/admin-user-creation.ts` for admin-created
  account setup links
- `packages/worker/src/app/email-verification.ts`,
  `packages/worker/src/app/handlers/verify-email.ts`, and
  `packages/worker/src/app/handlers/account-resend-verification.ts` for
  verification tokens and resends
- `packages/worker/src/app/handlers/account-secrets.ts` for owner-scoped secret
  reveal
- `packages/worker/src/app/deployment-env.ts` for the production/non-production
  gate shared by signup and developer-only routes
