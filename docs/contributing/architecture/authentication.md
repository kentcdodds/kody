# Authentication

`kody` is multi-user. Each signed-in user has a fully isolated assistant: their
own packages, jobs, secrets, values, memories, chat threads, remote connectors,
email inboxes, and durable storage. The auth layer is the boundary that
establishes which user a request belongs to before any handler reads or writes
data.

`kody` uses two related authentication models:

1. Cookie-based app sessions for browser users
2. OAuth bearer tokens for MCP access

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

- Accepts JSON body with `email`, `password`, `mode` (`login` or `signup`), and
  optional `rememberMe` for logins
- Uses D1 (`users` table) for user lookups and inserts
- Hashes passwords with `@kody-internal/shared/password-hash.ts`
- Returns signed session cookie via `Set-Cookie` on success
- Emits structured audit events through `packages/worker/src/app/audit-log.ts`

### Signup posture

Signup is **blocked in production** and only enabled in non-production runtimes
(local dev, preview, and e2e test). The gate lives in
`packages/worker/src/app/deployment-env.ts` (`isNonProductionRuntime`), which
the auth handler consults before honoring `mode: 'signup'`. Production wrangler
env sets `SENTRY_ENVIRONMENT: 'production'`; `npm run dev` sets
`WRANGLER_IS_LOCAL_DEV=true`; preview/test set `SENTRY_ENVIRONMENT` to
`'preview'` / `'test'`. The predicate fails closed: if it cannot positively
confirm a non-production runtime, signup is denied with `403`.

There is no application-level allowlist, invite flow, or privileged "primary
user" for the non-production environments where signup is enabled. Operators who
want to open signup on their own deployment should relax
`isNonProductionRuntime` deliberately and put the worker behind their own
network-layer access control.

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
- when `CLOUDFLARE_EMAIL_FROM` is unset, the handler logs a diagnostic without
  the email body or token URL to prevent token leakage in logs

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
- `packages/worker/src/app/handlers/account-secrets.ts` for owner-scoped secret
  reveal
- `packages/worker/src/app/deployment-env.ts` for the production/non-production
  gate shared by signup and developer-only routes
