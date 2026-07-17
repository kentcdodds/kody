# Social login (Sign in with GitHub / Google / X)

Kody supports social login as an OAuth 2.0 **client** of GitHub, Google, and X.
This is a third OAuth subsystem, deliberately separate from the other two:

- Kody-as-provider MCP OAuth (`/oauth/authorize`, `/oauth/callback`)
- Outbound integration OAuth for connecting third-party APIs (`/connect/oauth`)

Provider identities are stored in the `oauth_connections` D1 table
(`provider_name` + `provider_id` → `user_id`). No provider access tokens are
persisted; the token is used once per login to fetch the profile.

## How the flow behaves

Routes (see `packages/worker/src/app/handlers/auth-provider.ts` and
`packages/worker/src/app/handlers/account-connections.ts`):

- `GET /auth/providers.json` — enabled providers (drives the login buttons; a
  provider only appears when both its client id and secret env vars are set)
- `POST /auth/:provider` — starts the flow (signed `kody_oauth_login` state
  cookie with CSRF state + PKCE verifier + optional `inviteCode` query for
  production social signup). With `Accept: application/json` it returns
  `{ authorizeUrl }` for client-side navigation; otherwise it 302s.
- `GET /auth/:provider/callback` — completes the flow
- `GET/POST /account/connections.json` — signed-in connection management (list,
  disconnect)

The first-party UI always uses the JSON start mode: the CSP locks `form-action`
and `connect-src` to `'self'`, so neither a form-POST redirect nor a
fetch-followed redirect may leave the origin — the client fetches the start
endpoint and performs a top-level navigation to the returned authorize URL
itself.

Callback resolution order:

1. A **signed-in** user gets the provider identity linked to their account
   (`/account` has a "Connected accounts" card for this). A provider identity
   already linked to a different user is a conflict error, never an account
   switch; callback errors for signed-in users redirect to
   `/account?oauthError=<code>`.
2. A known connection signs in its user (the two-factor gate applies exactly as
   it does for password logins; passkey sign-in skips TOTP).
3. A **provider-verified** email matching an existing account links the identity
   and signs that account in (this also marks the account email verified, since
   the provider asserted ownership of the same address).
4. Otherwise a new account is created. Production requires a valid invite code
   carried in the signed OAuth state cookie (the invite signup panel passes
   `inviteCode` into `POST /auth/:provider`). Non-production stays open without
   an invite, but still consumes and validates a code when one is supplied —
   same posture as password signup. Missing or invalid invites redirect to
   `/login?oauthError=invite-*`.

X frequently does not share an email (it requires the "Request email from users"
app permission and a confirmed email), in which case only paths 1 and 2 work:
connect X from `/account` while signed in, then the X login button works.

Disconnecting a provider from `/account` is refused when it is the account's
only sign-in method (no usable password, no passkey, no other connection).

## Provider app setup

Use `https://<your-domain>/auth/<provider>/callback` as the callback/redirect
URL, for example `https://heykody.dev/auth/github/callback`. For local testing
against real providers use `http://localhost:3742/auth/<provider>/callback`.

### GitHub

1. Go to
   [GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers)
   and click **New OAuth App**.
2. Set **Homepage URL** to your app origin and **Authorization callback URL** to
   `https://<your-domain>/auth/github/callback`.
3. Register the app, then create a **client secret**.
4. Save the client id and secret as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

Scopes requested: `read:user user:email` (the primary verified email comes from
`GET /user/emails`).

### Google

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project.
2. Configure the **OAuth consent screen** (branding, support email; External is
   fine) under **APIs & Services**.
3. Under **Credentials**, create an **OAuth client ID** of type **Web
   application**.
4. Add `https://<your-domain>/auth/google/callback` as an **Authorized redirect
   URI**.
5. Save the client id and secret as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
6. Publish the consent screen (or add test users while in testing mode).

Scopes requested: `openid email profile` (profile read via the OIDC userinfo
endpoint; `email_verified` gates account matching).

### X

1. In the [X Developer Portal](https://developer.x.com/en/portal/dashboard),
   create a project and app.
2. Under the app's **User authentication settings**, enable **OAuth 2.0** with
   type **Web App** (confidential client).
3. Set the **Callback URI** to `https://<your-domain>/auth/x/callback` and the
   **Website URL** to your app origin.
4. Enable **Request email from users** so `confirmed_email` is returned (this
   makes email-based matching and invite-gated signup work for X).
5. Save the OAuth 2.0 client id and secret as `X_CLIENT_ID` / `X_CLIENT_SECRET`.

Scopes requested: `tweet.read users.read users.email` (PKCE S256 is mandatory;
the token endpoint uses HTTP Basic client authentication). Note that X meters
`GET /2/users/me` calls under its credit-based API pricing.

## Environment variables

All six are optional Worker secrets; a provider's button only renders when both
of its values are set (see `packages/worker/src/app/oauth-providers.ts`):

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `X_CLIENT_ID` / `X_CLIENT_SECRET`

For production deploys, store them as GitHub Actions repository secrets named
`OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`,
`OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_X_CLIENT_ID`, and
`OAUTH_X_CLIENT_SECRET` (the `OAUTH_` prefix avoids colliding with the reserved
`GITHUB_*` Actions namespace). `.github/workflows/deploy.yml` syncs them to the
Worker as the unprefixed secret names when present.

## Mocking and tests

A client id starting with `MOCK_` (with any non-empty secret) switches that
provider to an in-worker mock on **non-production runtimes only**
(`isMockOauthProvider` fails closed in production): the start redirect goes
straight back to the callback with a mock code, and the token/profile exchange
returns a canned profile from `getMockOauthProfile` without any network access.
`packages/worker/.env.example` and the `test` Wrangler env ship with MOCK
values, so local dev and Playwright E2E exercise the full redirect round-trip
out of the box. The mock X profile intentionally has no email to mirror the
common real-world case.

Coverage:

- `packages/worker/src/app/handlers/auth-provider.node.test.ts` — full
  start/callback flows against MSW-mocked GitHub/Google/X HTTP endpoints plus
  the mock-mode flow
- `e2e/social-login.spec.ts` — browser sign-in through the mock GitHub provider
