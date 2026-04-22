# OAuth guide

Read this guide first for third-party OAuth (GitHub, Linear, Spotify, and
similar providers).

This guide covers the standard hosted OAuth path. Use it before building a
package or package app that depends on the resulting connector or tokens.

## Default path: `/connect/oauth`

Send the signed-in user to `/connect/oauth` on your deployment host with query
parameters that describe the provider. The page runs authorize -> callback ->
token exchange in a full browser context and persists access and refresh tokens
through the account secrets flow.

This path does not require package-app-specific OAuth code.

Example shape:

`https://heykody.dev/connect/oauth?provider=...&authorizeUrl=...&tokenUrl=...`

## Redirect URI

Register this redirect URI in the provider console:

`{origin}/connect/oauth`

Use the same origin the user uses to open Kody.

## Required query parameters

| Param          | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| `provider`     | Short integration label used to derive stored names. |
| `authorizeUrl` | Provider authorization endpoint URL.                 |
| `tokenUrl`     | Provider token endpoint URL.                         |

The token endpoint host is always included for host approval. Add more API hosts
with `allowedHosts` when needed.

## Common optional parameters

| Param                       | Purpose                                    |
| --------------------------- | ------------------------------------------ |
| `flow`                      | `pkce` (default) or `confidential`.        |
| `scopes`                    | Space- or separator-separated scopes.      |
| `scopeSeparator`            | Defaults to a single space.                |
| `allowedHosts`              | Extra API hosts beyond the token host.     |
| `apiBaseUrl`                | Optional API base URL hint.                |
| `dashboardUrl`              | Provider settings link.                    |
| `extraAuthorizeParams`      | Provider-specific authorize params.        |
| `providerSetupInstructions` | Free-form setup hints shown in the wizard. |

Client ID, access token, and refresh token names are derived from a normalized
slug of `provider`.

## Not the same as MCP OAuth

`/connect/oauth` is for outbound provider OAuth.

Kody's MCP OAuth endpoints (`/oauth/authorize`, `/oauth/callback`, and related
routes) are for clients authenticating to Kody itself.

## When to use another guide

| Need                                                        | Use                  |
| ----------------------------------------------------------- | -------------------- |
| API keys or PATs instead of OAuth                           | `connect_secret`     |
| Custom browser UX or callback on a hosted package app route | `generated_ui_oauth` |

## Agent checklist

1. Confirm OAuth is the right auth shape.
2. Build the `/connect/oauth` URL with the required params.
3. Tell the user the exact redirect URI to register.
4. Have the user open the URL while signed in and wait for success.
5. Run the authenticated smoke test from `integration_bootstrap`.
6. Continue with the package or package app only after the smoke test passes.

## Package-first recommendation after OAuth

After the hosted `/connect/oauth` flow succeeds and the smoke test passes:

- build a package app when the integration needs a hosted UI
- keep provider API calls in package-owned backend code
- keep reusable automation in package exports
- use `open_generated_ui({ kody_id })` to reopen a hosted package app

Use `generated_ui_oauth` only when the package app itself must own the OAuth
browser flow.
