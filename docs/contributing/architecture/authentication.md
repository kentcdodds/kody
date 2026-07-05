# Authentication

`kody` is multi-user. Each signed-in user has a fully isolated assistant: their
own packages, jobs, secrets, values, memories, chat threads, remote connectors,
email inboxes, and durable storage. The auth layer is the boundary that
establishes which user a request belongs to before any handler reads or writes
data.

`kody` uses two related authentication models:

1. Cookie-based app sessions for browser users
2. OAuth bearer tokens for MCP access

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

- `id` (user id as string)
- `email`
- `rememberMe` and `issuedAt` for remembered sessions

`packages/worker/src/app/handler.ts` calls `setAuthSessionSecret` on each
request so cookie signing and verification are available to handlers.

## Login and signup

`POST /auth` is implemented by `packages/worker/src/app/handlers/auth.ts`.

- Accepts JSON body with `email`, `password`, `mode` (`login` or `signup`), an
  optional `inviteCode` for signups, and optional `rememberMe` for logins
- Uses D1 (`users` table) for user lookups and inserts
- Hashes passwords with `@kody-internal/shared/password-hash.ts`
- Returns signed session cookie via `Set-Cookie` on success
- Emits structured audit events through `packages/worker/src/app/audit-log.ts`

### Signup posture and invites

Production signup is invite-gated. The auth handler uses
`packages/worker/src/app/deployment-env.ts` (`isNonProductionRuntime`) to decide
whether an invite is required. Production wrangler env sets
`SENTRY_ENVIRONMENT: 'production'`; `npm run dev` sets
`WRANGLER_IS_LOCAL_DEV=true`; preview/test set `SENTRY_ENVIRONMENT` to
`'preview'` / `'test'`. The predicate fails closed: if the runtime cannot be
positively identified as non-production, signup requires a valid invite code.

The `invites` table stores operator-created invite codes:

- `code` is the primary key shown to the invited user
- `created_by` references the admin account that created it (nullable so account
  deletion does not strand invites)
- `note`, `max_uses`, `use_count`, `expires_at`, `revoked_at`, and `created_at`
  describe current invite state

Production signup atomically consumes an invite with a single conditional
`UPDATE ... WHERE use_count < max_uses AND revoked_at IS NULL ...`; concurrent
requests cannot over-use a code. Local dev, preview, and test runtimes remain
open when no invite is supplied, but they still consume and validate an invite
when a code is provided so E2E coverage can exercise the same path.

Admins manage invites at `/admin/invites`. The route uses the RBAC `admin` role
guard, not an owner-scoped content bypass. Invite creation, use, and revocation
emit audit events.

The same admin page can create a user directly by email for manually invited
people. That flow calls `adminCreateUserWithPasswordSetup` in
`packages/worker/src/app/admin-user-creation.ts` instead of going through the
web route logic directly, so future admin MCP capabilities can reuse the same
service. It:

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

Existing accounts are marked verified by the migration that introduces
`email_verified_at` so shipped users are not silently blocked by the new gate.
Seeded/test fixture accounts are also created verified. New accounts created via
normal signup start unverified, can still sign in, and see the unverified state
on `/account`.

At minimum, unverified accounts are blocked from sending outbound email. The MCP
email send/reply capabilities pass the authenticated account email into
`packages/worker/src/email/outbound.ts`, which checks `users.email_verified_at`
before sending through a verified sender identity.

### Password policy

New passwords (signup and password-reset confirmation) must satisfy the
server-side policy in `@kody-internal/shared/password-policy.ts`
(`minPasswordLength`, currently 8). The server is the trust boundary; the
browser hint is advisory only. Login does **not** re-check length so
pre-existing accounts are never locked out.

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
initial load and on client-side navigation events. If an in-flight refresh is
aborted, the client keeps the last known ready session instead of overwriting it
with `null`. This prevents transient logged-out UI during concurrent re-renders.

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

## Account secret reveal

The account secrets API (`packages/worker/src/app/handlers/account-secrets.ts`)
returns a decrypted secret value to the **owner** only, and only for the
currently selected secret:

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

## OAuth for MCP

OAuth endpoints are implemented in `packages/worker/src/oauth-handlers.ts` and
routed from `packages/worker/src/index.ts`.

- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token` (via provider)
- Client registration: `/oauth/register` (via provider)
- Supported scopes: `profile`, `email`
- On `/oauth/authorize`, unauthenticated users can log in inline or via top-nav
  auth links; those links preserve the full authorize URL in `redirectTo` so
  successful login/signup returns to the original OAuth request

`/mcp` is protected by `packages/worker/src/mcp-auth.ts`:

- Requires `Authorization: Bearer <token>`
- Token is validated via OAuth provider helpers (`unwrapToken`)
- Audience must match the app origin or `<origin>/mcp`
- Unauthenticated requests return `401` with `WWW-Authenticate` metadata

## What to read when changing auth

- `packages/worker/src/index.ts` for route order and integration points
- `packages/worker/src/oauth-handlers.ts` for OAuth authorization logic
- `packages/worker/src/mcp-auth.ts` for MCP token enforcement
- `packages/worker/src/app/auth-session.ts` for cookie format/signing
- `packages/worker/src/app/handlers/auth.ts` for app login/signup flow
- `packages/worker/src/app/invites.ts` and
  `packages/worker/src/app/handlers/admin-invites.ts` for invite management
- `packages/worker/src/app/admin-user-creation.ts` for admin-created account
  setup links
- `packages/worker/src/app/email-verification.ts` and
  `packages/worker/src/app/handlers/verify-email.ts` for verification tokens
- `packages/worker/src/app/handlers/account-secrets.ts` for owner-scoped secret
  reveal
- `packages/worker/src/app/deployment-env.ts` for the production/non-production
  gate shared by signup and developer-only routes
