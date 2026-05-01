# Authentication

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
never returns plaintext secret values in `GET /account/secrets.json`. To view a
stored value, the client calls a separate reveal endpoint:

- `POST /account/secrets/reveal` with JSON body `{ secretId, password }`
- Requires an active `kody_session` cookie (same as all account endpoints)
- Requires the user's current password for reauthentication (verified via
  PBKDF2 through `@kody-internal/shared/password-hash.ts`)
- On success, returns `{ ok: true, value }` with `Cache-Control: no-store`
- On failure (wrong password), returns 401 and writes an audit log entry with
  `action: 'secret_reveal'`, `result: 'failure'`
- Successful reveals also emit an audit log entry with
  `action: 'secret_reveal'`, `result: 'success'`

The UI prompts for the password on each reveal and does not cache the value in
memory across navigation events.

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
- `packages/worker/src/app/handlers/account-secrets.ts` for secret reveal with
  reauth
