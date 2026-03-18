# Authentication

`kody` uses two related authentication models:

1. Cookie-based app sessions for browser users
2. OAuth bearer tokens for MCP access

## Browser app sessions

Session cookie behavior is implemented in `server/auth-session.ts`.

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

`server/handler.ts` calls `setAuthSessionSecret` on each request so cookie
signing and verification are available to handlers.

## Login and signup

`POST /auth` is implemented by `server/handlers/auth.ts`.

- Accepts JSON body with `email`, `password`, `mode` (`login` or `signup`), and
  optional `rememberMe` for logins
- Uses D1 (`users` table) for user lookups and inserts
- Hashes passwords with `server/password-hash.ts`
- Returns signed session cookie via `Set-Cookie` on success
- Emits structured audit events through `server/audit-log.ts`

Related handlers:

- `GET /login` and `GET /signup`: `server/handlers/auth-page.ts`
- `POST /logout`: `server/handlers/logout.ts`
- `POST /session`: `server/handlers/session.ts` for session status checks
- `GET /account`: `server/handlers/account.ts` (redirects to login if missing
  session)

### Client session refresh behavior

The app shell (`client/app.tsx`) refreshes session state after initial load and
on client-side navigation events. If an in-flight refresh is aborted, the client
keeps the last known ready session instead of overwriting it with `null`. This
prevents transient logged-out UI during concurrent re-renders.

## Password reset

Password reset handlers are in `server/handlers/password-reset.ts`.

- `POST /password-reset` creates a one-time token and stores only its hash
- `POST /password-reset/confirm` verifies token hash and expiry, then updates
  password
- reset tokens expire after 1 hour
- when configured, email delivery is done via Resend

## OAuth for MCP

OAuth endpoints are implemented in `worker/oauth-handlers.ts` and routed from
`worker/index.ts`.

- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token` (via provider)
- Client registration: `/oauth/register` (via provider)
- Supported scopes: `profile`, `email`
- On `/oauth/authorize`, unauthenticated users can log in inline or via top-nav
  auth links; those links preserve the full authorize URL in `redirectTo` so
  successful login/signup returns to the original OAuth request

`/mcp` is protected by `worker/mcp-auth.ts`:

- Requires `Authorization: Bearer <token>`
- Token is validated via OAuth provider helpers (`unwrapToken`)
- Audience must match the app origin or `<origin>/mcp`
- Unauthenticated requests return `401` with `WWW-Authenticate` metadata

## What to read when changing auth

- `worker/index.ts` for route order and integration points
- `worker/oauth-handlers.ts` for OAuth authorization logic
- `worker/mcp-auth.ts` for MCP token enforcement
- `server/auth-session.ts` for cookie format/signing
- `server/handlers/auth.ts` for app login/signup flow
