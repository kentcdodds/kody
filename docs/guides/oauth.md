# OAuth guide (standard path)

**Read this guide first** for third-party OAuth (connect a user’s GitHub,
Linear, Spotify, etc. to Kody). The default pattern is Kody’s **hosted
connector**, not custom generated UI.

If the OAuth connection will power a downstream skill or app, load
`kody_official_guide` with `guide: "integration_bootstrap"` before building that
artifact. This guide covers the OAuth mechanics only.

## Default: `/connect/oauth`

Send the signed-in user to **`/connect/oauth`** on your deployment host with
query parameters that describe the provider. The page runs **authorize →
callback → token exchange** in a full browser context and persists access and
refresh tokens (and related values) via the account secrets API—**no**
\`open_generated_ui\`, \`ui_save_app\`, or \`kodyWidget\` OAuth code required.

Example shape (encode values for real URLs):

\`\`\`text
https://heykody.dev/connect/oauth?provider=…&authorizeUrl=…&tokenUrl=…&… \`\`\`

### Redirect URI

In the provider’s developer console, register the redirect URI as:

\`\`\`text {origin}/connect/oauth \`\`\`

Use the same origin the user uses to open Kody (callback lands on that path with
\`code\` and \`state\` query params).

### Required query parameters

| Param            | Purpose                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| \`provider\`     | Short label for the integration (letters/digits; drives stored value/secret names). |
| \`authorizeUrl\` | Provider authorization endpoint URL.                                                |
| \`tokenUrl\`     | Provider token endpoint URL.                                                        |

The token endpoint’s host is always included for host approval; add more with
\`allowedHosts\` if the API calls other origins.

### Common optional parameters

| Param                         | Purpose                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| \`flow\`                      | \`pkce\` (default) or \`confidential\` (client secret on token exchange). |
| \`scopes\`                    | Space- or separator-separated scopes (see \`scopeSeparator\`).            |
| \`scopeSeparator\`            | Defaults to a single space.                                               |
| \`allowedHosts\`              | Comma-separated extra API hosts beyond the token host.                    |
| \`apiBaseUrl\`                | Optional API base URL hint for documentation/UX.                          |
| \`dashboardUrl\`              | Link to the provider’s app or key settings.                               |
| \`extraAuthorizeParams\`      | Provider-specific authorize query params (encoding rules in the UI).      |
| \`providerSetupInstructions\` | Free-form setup hints shown in the wizard.                                |

Client ID, access token, and refresh token **names** are derived from a
normalized slug of \`provider\` (see
\`packages/worker/client/routes/connect-oauth.tsx\`).

### Not the same as MCP OAuth

Do **not** confuse **`/connect/oauth`** with Kody’s **MCP OAuth** endpoints
(\`/oauth/authorize\`, \`/oauth/callback\`, etc.). Those are for **clients
authenticating to Kody**. This guide is for **outbound** provider OAuth.

## If this path is not enough

| Need                                                                  | Use                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| API keys or PATs (paste-free), not OAuth                              | \`kody_official_guide\` with \`guide: "connect_secret"\` (\`/connect/secret\`).                                         |
| Custom UX, branding, or callback on a **saved app** URL (\`/ui/:id\`) | \`kody_official_guide\` with \`guide: "generated_ui_oauth"\` — see [Generated UI OAuth guide](./generated-ui-oauth.md). |

## Agent checklist (standard OAuth)

1. Confirm OAuth is appropriate (vs static secret → \`connect_secret\`).
2. Build the \`/connect/oauth\` URL with required params and any optional
   fields.
3. Tell the user the exact **redirect URI** to register:
   \`{origin}/connect/oauth\`.
4. Have the user open the connect URL while signed in; wait for success.
5. If the OAuth connection will back a saved skill or app, verify connector
   state and run the authenticated smoke test described in
   `guide: "integration_bootstrap"` before saving the downstream artifact.
6. Continue with capabilities that use \`{{secret:…}}\` or connector helpers;
   host/capability approval may still be required after save.
