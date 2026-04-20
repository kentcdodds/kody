# Generated UI OAuth guide

**This is the edge-case guide.** Use it when **`/connect/oauth` is not
sufficient** and the integration needs a hosted package app callback or a custom
browser-first OAuth experience.

For standard third-party OAuth, use the normal hosted connector path from
[OAuth guide](./oauth.md).

## When to use this guide

Use this guide when the package app needs:

- branded or multi-step UX during OAuth
- tight coupling with other browser-side package app state
- a callback on the hosted package app URL instead of `/connect/oauth`
- browser-side PKCE code exchange with package app helpers

## Core rules

- Do not use an ephemeral inline render for browser-based OAuth callbacks.
- Use a hosted package app URL as the callback target.
- Tell the user to open the hosted package app URL in a normal browser tab or
  window.
- Exchange browser callback codes with browser-safe helpers such as
  `exchangePkceOAuthCode(...)`.
- Treat server-side confidential-client exchange as a separate flow.

## Recommended sequence

1. Build or update the hosted package app.
2. Save the package with `package_save`.
3. Tell the user the exact hosted callback URL and registration values.
4. Have the user open the hosted package app URL in a browser.
5. In the hosted package app, use `@kody/ui-utils` helpers to:
   - create OAuth state
   - read callback params
   - validate state
   - exchange the code
   - save tokens

## Generated UI helpers

Use these helpers instead of hand-rolling the flow:

- `saveValue({ name, value, description?, scope? })`
- `getValue({ name, scope? })`
- `saveSecret({ name, value, description?, scope? })`
- `createOAuthState(key)`
- `readOAuthCallback({ expectedStateKey })`
- `validateOAuthCallbackState({ key, returnedState })`
- `exchangePkceOAuthCode({ tokenUrl, code, redirectUri, clientId, codeVerifier, extraParams? })`
- `exchangeOAuthCodeWithSecrets({ tokenUrl, code, redirectUri, clientId, clientSecretSecretName, scope?, extraParams? })`
- `saveOAuthTokens({ payload, accessTokenSecretName, refreshTokenSecretName?, scope?, accessTokenDescription?, refreshTokenDescription? })`

## Package app structure

For most browser-driven OAuth package apps:

1. setup view
2. connect action
3. callback handler
4. success view
5. error view

Keep provider API calls in package-owned backend code after auth is complete.
Use browser-side package app code for the callback and token save path only.

## Registration values

When the provider requires manual registration, give the user exact values for:

- callback or redirect URL
- app homepage URL when required
- allowed origin or JavaScript origin when required
- logout URL when required

Do not tell the user only to “set up OAuth” without concrete values.
