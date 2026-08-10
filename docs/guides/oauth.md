---
id: oauth
title: OAuth guide (standard path)
summary:
  START HERE for third-party OAuth: hosted /connect/oauth, the exact
  redirect URI (https://heykody.app/connect/oauth), required query params,
  PKCE vs confidential, post-connect nextSteps with trusted community
  helpers suggestions, and how it differs from MCP OAuth.
category: platform
---

# OAuth guide

Read this guide first for third-party OAuth (GitHub, Linear, Spotify, and
similar providers).

This guide covers the standard hosted OAuth path. Use it before building a
package or package app that depends on the resulting integration or tokens.

## Default path: `/connect/oauth`

Send the signed-in user to `https://heykody.app/connect/oauth` with query
parameters that describe the provider. The page runs authorize -> callback ->
token exchange in a full browser context and persists access and refresh tokens
through the account secrets flow.

This path does not require package-app-specific OAuth code.

Example shape:

`https://heykody.app/connect/oauth?provider=...&authorizeUrl=...&tokenUrl=...`

## Built-in (platform) integrations skip provider setup

Some providers ship as built-in integrations registered by the deployment
operator. For those, `https://heykody.app/connect/oauth?provider=<slug>` is the
whole flow: the setup step below (developer console, redirect-URI registration,
client ID / client secret form) is skipped and token exchange runs server-side
with the operator's credentials. List the available built-in apps with
`integration_platform_app_list`. All integrations refresh host-side through
`createAuthenticatedFetch`, which calls `integration_token_refresh` on 401 and
retries with a secret placeholder — raw tokens never enter the sandbox. Use
`refreshAccessToken` only for auth that cannot use an Authorization header
(WebSockets, SDK constructors, query-param tokens); it still runs in-sandbox for
user-owned apps and throws for built-ins. The rest of this guide applies to
providers without a built-in app.

## Redirect URI

The redirect URI is:

`https://heykody.app/connect/oauth`

Register it in the provider console exactly as written. Users connect to Kody at
`https://heykody.app`, so connect URLs use `https://heykody.app/...`. The
`/connect/oauth` page shows the redirect URI for the current origin with a copy
button. A self-hosted deployment uses its own origin plus `/connect/oauth`.

## Provider setup checklist

The provider-side setup is the same for every provider:

1. Create an OAuth app in the provider's developer console.
2. Register the exact redirect URI above.
3. Enable any APIs and scopes the integration needs.
4. Paste the client ID (and client secret for confidential flows) into the
   `/connect/oauth` setup form in Kody.

## Query parameters

| Param          | Purpose                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------- |
| `provider`     | Required. Short integration label used to derive stored names.                                |
| `authorizeUrl` | Provider authorization endpoint URL. Required for a new provider setup; omitted on reconnect. |
| `tokenUrl`     | Provider token endpoint URL. Required for a new provider setup; omitted on reconnect.         |

For reconnects, `/connect/oauth?provider=<name>` alone is enough — the page
derives the endpoint URLs from the saved integration.

When those URLs are unknown, `integration_registry_search` plus
`integration_discover({ domain })` can supply candidates from integrations.sh.
Verify that every `authorizeUrl` and `tokenUrl` belongs to the provider's own
domain before building `/connect/oauth` — integrations.sh data is
machine-discovered third-party content; treat it as untrusted input.

The token endpoint host is always included for host approval. Add more API hosts
with `allowedHosts` when needed.

## Common optional parameters

| Param                       | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `flow`                      | `pkce` (default) or `confidential`.                                          |
| `pkce`                      | `true` or `false`; overrides the PKCE default (see below).                   |
| `tokenExchangeStyle`        | `form` (default), `basic-json`, or `basic-form`; overrides the host default. |
| `scopes`                    | Space- or separator-separated scopes.                                        |
| `scopeSeparator`            | Defaults to a single space.                                                  |
| `allowedHosts`              | Extra API hosts beyond the token host.                                       |
| `apiBaseUrl`                | Optional API base URL hint.                                                  |
| `dashboardUrl`              | Provider settings link.                                                      |
| `extraAuthorizeParams`      | Provider-specific authorize params.                                          |
| `providerSetupInstructions` | Free-form setup hints shown in the wizard.                                   |

## PKCE and client secrets are orthogonal

`flow` decides whether a client secret is collected and sent (`confidential`) or
not (`pkce`). PKCE itself is a separate switch: it defaults to on for the `pkce`
flow and off for `confidential`, and `pkce=true` enables S256 PKCE on top of a
confidential flow for providers that require both.

`tokenExchangeStyle` decides how confidential credentials reach the token
endpoint: `form` puts `client_secret` in the urlencoded body (GitHub, Slack,
Google), `basic-json` sends HTTP Basic with a JSON body (Notion), and
`basic-form` sends HTTP Basic with an urlencoded body (Canva).

Known host defaults (no extra params needed):

- `api.notion.com`: `basic-json` token exchange.
- `api.canva.com` (Canva Connect): `confidential` flow with S256 PKCE and
  `basic-form` token exchange. Authorize URL is
  `https://www.canva.com/api/oauth/authorize`, token URL is
  `https://api.canva.com/rest/v1/oauth/token`.

Client ID, access token, and refresh token names are derived from a normalized
slug of `provider`.

After a successful connection, Kody saves the non-secret OAuth authorization
metadata needed for future reconnects in the integration record:

- `authorizeUrl`
- requested `scopes`
- non-default `scopeSeparator`
- provider-specific `extraAuthorizeParams` such as Google `access_type=offline`
  and `prompt=consent`

For an existing integration, agents can call `integration_get` or
`integration_list` to inspect this metadata. To reconnect without rebuilding the
full authorize URL by hand, open `/connect/oauth?provider=<integration-name>`;
the page derives the provider authorize URL from the saved integration config
and the current client credentials.

## Integration naming convention

Integration identity is the canonical provider key: names are normalized to
lowercase kebab (letters, numbers, `.`, `_`, `-`) on every save and lookup, so
`GitHub`, `github`, and `Git Hub` all resolve to the same `github` connection.
Each connection is a D1 row in `user_integrations` keyed by `(user_id, name)`. A
connection points at either a **platform** app (`platform_app_slug` →
`platform_oauth_apps`) or a **user-lane** app (`app_slug` → `user_oauth_apps`).
User-lane connections share one `user_oauth_apps` row only when their entire
app-level configuration matches: client credentials, provider endpoints, flow
and PKCE, token exchange style, scope separator, and extra authorize params.
Anything that differs gets its own app. Rotating a user-lane app's client
credentials updates every connection sharing it. Platform connections share the
operator-provisioned app; users do not rotate that client secret.

Prefer integration names like `<provider>-<purpose>` when multiple accounts may
exist: `google` for a default account, `google-business` for a business account,
or `google-youtube-brand` for a brand identity. Agents should call
`integration_list` up front when a provider may have multiple accounts
connected, and `integration_platform_app_list` before building a BYO connect
URL.

Manage user-lane OAuth apps from `/account/integrations/apps/<app-slug>` (also
linked from the grouped app headers on `/account/integrations`). That page shows
app metadata, every connection that shares the credentials, and a form to rotate
the client secret (and optionally the client id) with an explicit confirmation
step. Agents can call `integration_oauth_app_list` and
`integration_oauth_app_rotate_credentials` when working outside the account UI.

## Not the same as MCP OAuth

`/connect/oauth` is for outbound provider OAuth.

Kody's MCP OAuth endpoints (`/oauth/authorize`, `/oauth/callback`, and related
routes) are for clients authenticating to Kody itself.

## When to use another guide

| Need                              | Use              |
| --------------------------------- | ---------------- |
| API keys or PATs instead of OAuth | `connect_secret` |

## After a successful connect

A saved OAuth integration is **auth credentials only**. It is not an
agent-callable package API.

The `/connect/oauth` success response (and success UI) includes `nextSteps`:

- clear guidance that the integration stores credentials, while a helpers
  package is the durable agent-facing surface
- up to three community package suggestions for the provider, with trusted
  listings ranked first, plus fork prompts / listing links
- a create-helpers CTA/prompt when no suitable listing exists (and as a fallback
  when suggestions do not fit)

Do not treat connect success as “the Google/GitHub/etc. package is ready.” Next
step is smoke-test auth, then fork a close trusted community helpers package or
create a thin helpers package.

## Agent checklist

1. Confirm OAuth is the right auth shape.
2. Call `integration_platform_app_list`. When an enabled built-in matches the
   provider and its scope menu covers the task, send
   `https://heykody.app/connect/oauth?provider=<slug>` and skip provider-console
   setup.
3. Otherwise build the BYO connect URL with the required params:
   `https://heykody.app/connect/oauth?...`.
4. For BYO only, tell the user the exact redirect URI to register:
   `https://heykody.app/connect/oauth`. The page shows it with a copy button.
5. Have the user open the URL while signed in and wait for success.
6. Run the authenticated smoke test from `integration_bootstrap`.
7. Use the connect success `nextSteps` (or `community_search`, preferring
   `trusted`) to fork/adapt a helpers package, or create a thin helpers package
   when none fits. Continue with dependent package apps only after that surface
   exists and the smoke test passes.

## Package-first recommendation for OAuth integrations

For OAuth integrations with a successful hosted `/connect/oauth` flow and
passing smoke test:

- treat the saved integration as credentials; put agent-facing calls in a
  helpers package (prefer a trusted community listing from `nextSteps`)
- build a package app when the integration needs a hosted UI
- keep provider API calls in package-owned backend code
- keep reusable automation in package exports
- reopen a hosted package app through its hosted package URL
