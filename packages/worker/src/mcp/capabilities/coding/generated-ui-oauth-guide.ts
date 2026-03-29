import { z } from 'zod'
import { defineDomainCapability } from '../define-domain-capability.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { type CapabilityContext } from '../types.ts'

const inputSchema = z
	.object({})
	.describe(
		'No input. Returns the current Kody-specific guidance for building OAuth flows in generated UI apps.',
	)

const outputSchema = z.object({
	title: z.string().describe('Guide title.'),
	body: z
		.string()
		.describe(
			'Markdown guidance for implementing OAuth in generated UI apps, including hosted callbacks, PKCE versus server-side helper usage, token persistence, and code examples.',
		),
})

const guideBody = `
# Generated UI OAuth guide

Use this guide before generating or revising a generated UI that implements a
browser-based OAuth flow.

## When to use this guide

Use it when the UI needs to:

- connect a third-party account with OAuth
- receive a provider callback with \`code\` and \`state\`
- exchange an authorization code for tokens with saved values and secrets
- tell the user what callback or redirect URL to register with the provider

## Core rules

For browser-based OAuth callbacks, do not rely on an ephemeral inline render.
Save the UI first with \`ui_save_app\`, then use the hosted saved-app URL as the
provider callback or redirect target.

Do not try to complete the OAuth flow inside the conversation iframe. OAuth
callbacks must return to the hosted saved-app URL in a normal browser tab or
window, so the agent should give the user that hosted URL and tell them to open
it in their browser.

\`executeCode(...)\` and secret-aware helper execution happen server-side. Do
not use that server-side path to exchange an authorization code for tokens
during the browser callback. For browser-based OAuth, exchange the code in the
hosted browser page with \`exchangePkceOAuthCode(...)\` when the provider
supports PKCE, then save the returned access token or refresh token as secrets.

For hosted browser callback pages, prefer \`exchangePkceOAuthCode(...)\` when
the provider supports PKCE and browser token exchanges. Treat
\`exchangeOAuthCodeWithSecrets(...)\` as a separate server-side utility for
confidential-client flows, not the default callback path in this guide.

Use the generated UI OAuth helpers instead of hand-rolling URL parsing, state
storage, token exchange, or token persistence.

When the flow needs readable, non-sensitive configuration such as a client ID,
save it with \`saveValue(...)\` and read it back with \`getValue(...)\` instead
of treating it like a secret.

## Recommended capability and tool sequence

1. Generate the UI source.
2. Save it with \`ui_save_app\` if the provider must redirect back to the app.
3. Tell the user the exact hosted callback URL and any other provider
   registration values they need.
4. Give the user the hosted saved-app URL and tell them to open it in their
   browser instead of trying to complete the flow in the conversation iframe.
5. In the hosted generated UI, import \`kodyWidget\` from
   \`@kody/ui-utils\` and use it directly to read the callback, validate state,
   exchange the code in the browser, and save tokens.

## Generated UI helpers to use

Use these helpers instead of hand-rolling the flow:

- \`saveValue({ name, value, description?, scope? })\`
- \`getValue({ name, scope? })\`
- \`saveSecret({ name, value, description?, scope? })\`
- \`createOAuthState(key)\`
- \`readOAuthCallback({ expectedStateKey })\`
- \`validateOAuthCallbackState({ key, returnedState })\`
- \`exchangePkceOAuthCode({ tokenUrl, code, redirectUri, clientId, codeVerifier, extraParams? })\`
- \`exchangeOAuthCodeWithSecrets({ tokenUrl, code, redirectUri, clientId, clientSecretSecretName, scope?, extraParams? })\`
- \`saveOAuthTokens({ payload, accessTokenSecretName, refreshTokenSecretName?, scope?, accessTokenDescription?, refreshTokenDescription? })\`

## Choosing the exchange helper

For hosted browser callback pages in a saved app:

- prefer \`exchangePkceOAuthCode(...)\` when the provider supports PKCE and the
  token endpoint is browser-safe
- use \`exchangeOAuthCodeWithSecrets(...)\` only for an intentional server-side
  confidential-client exchange, not as the default browser callback flow

## Example: loading a saved client ID

When the client ID is public configuration, read it with \`getValue(...)\`
before building the authorization URL or token request.

\`\`\`html
<p id="status"></p>
<script type="module">
  import { kodyWidget } from '@kody/ui-utils'

  async function requireClientId() {
    const clientIdRecord = await kodyWidget.getValue({
      name: 'muffin-club-oauth-client-id',
      scope: 'user',
    })

    if (!clientIdRecord) {
      const message =
        'Missing OAuth client ID. Ask the user to save the client configuration and retry.'
      const status = document.querySelector('#status')
      if (status) status.textContent = message
      kodyWidget.sendMessage(message)
      return null
    }

    return clientIdRecord.value
  }
</script>
\`\`\`

Use the returned value for \`client_id\` in the provider authorization URL or
in \`exchangePkceOAuthCode(...)\` or \`exchangeOAuthCodeWithSecrets(...)\` when
the provider treats the client ID as readable, non-secret configuration.

## Recommended app structure

For most provider-connection flows, structure the generated UI like this:

1. A setup view that explains what will happen and, if needed, collects client
   credentials with a form.
2. A connect action that creates OAuth state and sends the browser to the
   provider's authorization URL.
3. A callback handler that runs when the provider redirects back with
   \`code\` and \`state\`.
4. A success view that confirms the account is connected.
5. An error view that explains what failed and what the user should do next.

## Recommended callback flow

1. Read the callback with \`readOAuthCallback(...)\`.
2. If the provider returned an OAuth error, show that error to the user.
3. Validate the returned state with \`validateOAuthCallbackState(...)\`.
4. For hosted browser callback pages, prefer \`exchangePkceOAuthCode(...)\`
   when the provider supports PKCE and browser token exchanges.
5. If the exchange succeeds, save the returned access token or refresh token
   with \`saveOAuthTokens(...)\` or \`saveSecret(...)\`.
6. Continue with whatever post-connect behavior the app needs.

## Registration values to give the user

When the provider does not support dynamic client registration, tell the user
the exact values they need to enter in the provider's app settings.

At minimum, include:

- callback or redirect URL
- app homepage URL when required
- allowed origin or JavaScript origin when required
- logout URL when required by that provider

Do not tell the user only to "set up OAuth" without giving the concrete values.

## Example: saving client configuration

If the user needs to provide a client ID and client secret, save the client ID
as a readable value and the client secret as a secret before starting the
authorization flow.

\`\`\`html
<form id="oauth-client-form">
  <label>
    Client ID
    <input name="clientId" autocomplete="off" required />
  </label>
  <label>
    Client Secret
    <input name="clientSecret" type="password" autocomplete="off" required />
  </label>
  <button type="submit">Save and continue</button>
</form>
<script type="module">
  import { kodyWidget } from '@kody/ui-utils'

  document.querySelector('#oauth-client-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const values = kodyWidget.formToObject(form)
    const clientId = values.clientId
    const clientSecret = values.clientSecret

    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return

    const [clientIdResult, clientSecretResult] = await Promise.all([
      kodyWidget.saveValue({
        name: 'muffin-club-oauth-client-id',
        value: clientId,
        description: 'Muffin Club OAuth client ID',
        scope: 'user',
      }),
      kodyWidget.saveSecret({
        name: 'muffin-club-oauth-client-secret',
        value: clientSecret,
        description: 'Muffin Club OAuth client secret',
        scope: 'user',
      }),
    ])

    if (!clientIdResult.ok || !clientSecretResult.ok) {
      document.body.insertAdjacentHTML('beforeend', '<p>Unable to save configuration.</p>')
      return
    }

    document.body.insertAdjacentHTML('beforeend', '<p>Configuration saved.</p>')
  })
</script>
\`\`\`

Saved secrets are not readable back into browser code. If the hosted callback
page needs to exchange the authorization code in the browser, keep the browser
exchange focused on values the page can access directly, such as the saved
client ID and any provider-specific browser-safe parameters.

If the provider requires a confidential-client secret for the token exchange,
that is a different flow from the browser callback path described in this guide.
Do not assume the hosted callback page can read the secret back out.

## Example: starting the authorization redirect

Create and persist the OAuth state before redirecting the browser.

\`\`\`html
<button id="connect-muffin-club">Connect Muffin Club</button>
<script type="module">
  import { kodyWidget } from '@kody/ui-utils'

  document.querySelector('#connect-muffin-club')?.addEventListener('click', async () => {
    const clientIdRecord = await kodyWidget.getValue({
      name: 'muffin-club-oauth-client-id',
      scope: 'user',
    })
    if (!clientIdRecord) {
      kodyWidget.sendMessage('Missing OAuth client ID value. Ask the user to save the client configuration and retry.')
      return
    }
    const state = kodyWidget.createOAuthState('muffin-club-oauth')
    const redirectUri = window.location.origin + window.location.pathname
    const authUrl = new URL('https://auth.muffinclub.example/oauth/authorize')
    authUrl.searchParams.set('client_id', clientIdRecord.value)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', 'menu.read profile')
    authUrl.searchParams.set('state', state)
    window.location.assign(authUrl.toString())
  })
</script>
\`\`\`

Reading the client ID from \`getValue(...)\` keeps it out of the UI source while
still treating it as readable configuration rather than a secret.

For PKCE flows, also create and store a code verifier before redirecting,
include the derived \`code_challenge\` in the authorization URL, and pass the
stored verifier to \`exchangePkceOAuthCode(...)\` on callback.

## Example: handling the callback

This is the most important part of the flow. Exchange the code in the hosted
browser page, then save the returned tokens only after the browser request
succeeds.

\`\`\`html
<div id="app"></div>
<script type="module">
  const root = document.querySelector('#app')

  async function handleCallback(kodyWidget, code, returnedState) {
    const validation = kodyWidget.validateOAuthCallbackState({
      key: 'muffin-club-oauth',
      returnedState,
    })

    if (!validation.valid) {
      root.innerHTML = '<p>State mismatch. Please restart the connection flow.</p>'
      return
    }

    const clientIdRecord = await kodyWidget.getValue({
      name: 'muffin-club-oauth-client-id',
      scope: 'user',
    })
    if (!clientIdRecord) {
      root.innerHTML = '<p>Missing client ID. Save the OAuth configuration and retry.</p>'
      kodyWidget.sendMessage('Missing OAuth client ID value. Ask the user to save the client configuration and retry.')
      return
    }

    const codeVerifier = sessionStorage.getItem('muffin-club-oauth-code-verifier')
    if (!codeVerifier) {
      root.innerHTML = '<p>Missing PKCE code verifier. Restart the connection flow.</p>'
      return
    }

    const tokenResult = await kodyWidget.exchangePkceOAuthCode({
      tokenUrl: 'https://auth.muffinclub.example/oauth/token',
      code,
      redirectUri: window.location.origin + window.location.pathname,
      clientId: clientIdRecord.value,
      codeVerifier,
    })

    if (tokenResult.ok && tokenResult.data && typeof tokenResult.data === 'object') {
      const saved = await kodyWidget.saveOAuthTokens({
        payload: tokenResult.data,
        accessTokenSecretName: 'muffin-club-access-token',
        refreshTokenSecretName: 'muffin-club-refresh-token',
        scope: 'user',
        accessTokenDescription: 'Muffin Club OAuth access token',
        refreshTokenDescription: 'Muffin Club OAuth refresh token',
      })

      root.innerHTML = saved.ok
        ? '<p>Muffin Club is connected.</p>'
        : '<p>Token exchange succeeded, but saving the token failed.</p>'
      return
    }

    const message = tokenResult.ok
      ? 'Token exchange failed: invalid JSON response from the provider.'
      : tokenResult.kind === 'http_error'
        ? 'Token exchange failed with HTTP status ' + tokenResult.status + '.'
        : 'Token exchange failed: ' + tokenResult.message
    root.innerHTML = '<p>' + message + '</p>'
  }

  import { kodyWidget } from '@kody/ui-utils'

  void (async () => {
    const callback = kodyWidget.readOAuthCallback({
      expectedStateKey: 'muffin-club-oauth',
    })

    if (callback.kind === 'error') {
      root.innerHTML = '<p>OAuth error: ' + callback.error + '</p>'
    } else if (callback.kind === 'success') {
      await handleCallback(kodyWidget, callback.code, callback.state)
    }
  })()
</script>
\`\`\`

## Server-side execution note

\`executeCode(...)\`, \`fetchWithSecrets(...)\`, and
\`exchangeOAuthCodeWithSecrets(...)\` run server-side. That is useful for some
generated UI workflows, but it is not the default path for the hosted browser
callback step of an OAuth authorization-code flow.

For the hosted browser callback step in this guide:

1. read \`code\` and \`state\` in the hosted browser page
2. validate state in that browser page
3. prefer \`exchangePkceOAuthCode(...)\` when the provider supports PKCE and a
   browser token exchange
4. save the returned token payload with \`saveOAuthTokens(...)\` or
   \`saveSecret(...)\`

Use \`exchangeOAuthCodeWithSecrets(...)\` only when you intentionally need a
server-side confidential-client exchange and understand that it is not running
in the browser callback page.

## Implementation checklist for generated UI code

Before you consider the flow complete, verify that the generated UI:

- uses a hosted saved app for browser callbacks
- tells the user to open the hosted saved-app URL in a browser instead of
  relying on the conversation iframe
- creates OAuth state before redirecting
- validates the returned state on callback
- handles provider callback errors
- uses \`exchangePkceOAuthCode(...)\` for hosted browser callback pages when the
  provider supports PKCE
- does not default to \`exchangeOAuthCodeWithSecrets(...)\` for the hosted
  browser callback path in this guide
- saves OAuth tokens only after a successful exchange
- tells the user the exact provider registration values they need
- avoids asking the user to paste secrets into chat

## Implementation notes for generated UI code

- Prefer hosted saved apps for OAuth callbacks.
- Prefer the built-in OAuth helpers over manual URL parsing and state storage.
- Remember that \`executeCode(...)\` runs server-side.
- For hosted browser callback pages, prefer \`exchangePkceOAuthCode(...)\` when
  the provider supports PKCE.
- Treat \`exchangeOAuthCodeWithSecrets(...)\` as a separate server-side helper,
  not the default hosted callback path for this guide.
- Call \`saveOAuthTokens(...)\` only after a successful exchange.
- If the generated UI needs secrets, collect them in the UI and save them with
  \`saveSecret(...)\` or \`saveSecrets(...)\`.
- If the generated UI needs readable, non-sensitive configuration such as a
  client ID, save it with \`saveValue(...)\` and read it with \`getValue(...)\`.
- If the provider flow depends on user-entered values that should survive a
  refresh, consider \`persistForm(...)\` and \`restoreForm(...)\`.
`.trim()

export const generatedUiOAuthGuideCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'generated_ui_oauth_guide',
		description:
			'Read the Kody-specific guide for implementing OAuth flows in generated UI apps. Call this before building a hosted OAuth callback flow, provider registration instructions, browser PKCE exchange UI, or server-side OAuth exchange UI.',
		keywords: [
			'oauth',
			'pkce',
			'generated ui',
			'hosted callback',
			'redirect uri',
			'provider registration',
			'ui_save_app',
			'open_generated_ui',
			'@kody/ui-utils',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(_args, _ctx: CapabilityContext) {
			return {
				title: 'Generated UI OAuth guide',
				body: guideBody,
			}
		},
	},
)
