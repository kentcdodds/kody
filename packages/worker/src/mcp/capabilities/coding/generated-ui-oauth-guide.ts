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
			'Markdown guidance for implementing OAuth in generated UI apps, including hosted callbacks, helper usage, host approval handling, and code examples.',
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
- exchange an authorization code for tokens with saved secrets
- tell the user what callback or redirect URL to register with the provider

## Core rules

For browser-based OAuth callbacks, do not rely on an ephemeral inline render.
Save the UI first with \`ui_save_app\`, then use the hosted saved-app URL as the
provider callback or redirect target.

Use the generated UI OAuth helpers instead of hand-rolling URL parsing, state
storage, token exchange, or token persistence.

## Recommended capability and tool sequence

1. Generate the UI source.
2. Save it with \`ui_save_app\` if the provider must redirect back to the app.
3. Tell the user the exact hosted callback URL and any other provider
   registration values they need.
4. Reopen or render the UI with \`open_generated_ui\`.
5. In the generated UI, use the OAuth helpers on \`window.kodyWidget\` to read
   the callback, validate state, exchange the code, and save tokens.

## Generated UI helpers to use

Use these helpers instead of hand-rolling the flow:

- \`createOAuthState(key)\`
- \`readOAuthCallback({ expectedStateKey })\`
- \`validateOAuthCallbackState({ key, returnedState })\`
- \`exchangeOAuthCode({ tokenUrl, code, redirectUri, clientIdSecretName, clientSecretSecretName, scope?, extraParams? })\`
- \`saveOAuthTokens({ payload, accessTokenSecretName, refreshTokenSecretName?, scope?, accessTokenDescription?, refreshTokenDescription? })\`

## Recommended app structure

For most provider-connection flows, structure the generated UI like this:

1. A setup view that explains what will happen and, if needed, collects client
   credentials with a form.
2. A connect action that creates OAuth state and sends the browser to the
   provider's authorization URL.
3. A callback handler that runs when the provider redirects back with
   \`code\` and \`state\`.
4. A success view that confirms the account is connected.
5. An approval-required view when the token exchange is blocked by secret host
   approval.

## Recommended callback flow

1. Read the callback with \`readOAuthCallback(...)\`.
2. If the provider returned an OAuth error, show that error to the user.
3. Validate the returned state with \`validateOAuthCallbackState(...)\`.
4. Call \`exchangeOAuthCode(...)\`.
5. If the exchange succeeds, call \`saveOAuthTokens(...)\`.
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

## Example: saving client credentials

If the user needs to provide a client ID and client secret, save them as
secrets before starting the authorization flow.

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
<script>
  document.querySelector('#oauth-client-form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const values = window.kodyWidget.formToObject(form)
    const clientId = values.clientId
    const clientSecret = values.clientSecret

    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return

    const result = await window.kodyWidget.saveSecrets([
      {
        name: 'muffin-club-oauth-client-id',
        value: clientId,
        description: 'Muffin Club OAuth client ID',
        scope: 'user',
      },
      {
        name: 'muffin-club-oauth-client-secret',
        value: clientSecret,
        description: 'Muffin Club OAuth client secret',
        scope: 'user',
      },
    ])

    if (!result.ok) {
      document.body.insertAdjacentHTML('beforeend', '<p>Unable to save credentials.</p>')
      return
    }

    document.body.insertAdjacentHTML('beforeend', '<p>Credentials saved.</p>')
  })
</script>
\`\`\`

## Example: starting the authorization redirect

Create and persist the OAuth state before redirecting the browser.

\`\`\`html
<button id="connect-muffin-club">Connect Muffin Club</button>
<script>
  document.querySelector('#connect-muffin-club')?.addEventListener('click', () => {
    const state = window.kodyWidget.createOAuthState('muffin-club-oauth')
    const redirectUri = window.location.origin + window.location.pathname
    const authUrl = new URL('https://auth.muffinclub.example/oauth/authorize')
    authUrl.searchParams.set('client_id', 'REPLACE_WITH_REGISTERED_CLIENT_ID_IF_NEEDED')
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', 'menu.read profile')
    authUrl.searchParams.set('state', state)
    window.location.assign(authUrl.toString())
  })
</script>
\`\`\`

When the provider client ID is also stored as a secret and should not be
embedded in the UI source, prefer rendering the authorization URL from server
data or another safe source rather than hardcoding it.

## Example: handling the callback

This is the most important part of the flow. Treat the token exchange as a
branching result, not a generic success or failure.

\`\`\`html
<div id="app"></div>
<script>
  const root = document.querySelector('#app')
  const callback = window.kodyWidget.readOAuthCallback({
    expectedStateKey: 'muffin-club-oauth',
  })

  async function handleCallback(code, returnedState) {
    const validation = window.kodyWidget.validateOAuthCallbackState({
      key: 'muffin-club-oauth',
      returnedState,
    })

    if (!validation.valid) {
      root.innerHTML = '<p>State mismatch. Please restart the connection flow.</p>'
      return
    }

    const tokenResult = await window.kodyWidget.exchangeOAuthCode({
      tokenUrl: 'https://auth.muffinclub.example/oauth/token',
      code,
      redirectUri: window.location.origin + window.location.pathname,
      clientIdSecretName: 'muffin-club-oauth-client-id',
      clientSecretSecretName: 'muffin-club-oauth-client-secret',
      scope: 'user',
    })

    if (tokenResult.ok) {
      const saved = await window.kodyWidget.saveOAuthTokens({
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

    if (tokenResult.kind === 'host_approval_required') {
      const approvalLink = tokenResult.approvalUrl
        ? '<p><a href="' + tokenResult.approvalUrl + '" target="_blank" rel="noreferrer">Approve host access</a></p>'
        : ''
      root.innerHTML =
        '<p>Kody needs approval to use your saved OAuth secret with ' +
        (tokenResult.host || 'this provider host') +
        '.</p>' +
        approvalLink +
        '<p>After approval, retry the connection flow.</p>'
      return
    }

    const message =
      tokenResult.kind === 'http_error'
        ? 'Token exchange failed with HTTP status ' + tokenResult.status + '.'
        : 'Token exchange failed: ' + tokenResult.message
    root.innerHTML = '<p>' + message + '</p>'
  }

  if (callback.kind === 'error') {
    root.innerHTML = '<p>OAuth error: ' + callback.error + '</p>'
  } else if (callback.kind === 'success') {
    void handleCallback(callback.code, callback.state)
  }
</script>
\`\`\`

## Host approval behavior

Secret save and secret use are separate steps.

Saving the client ID or client secret does not authorize sending those secrets
to the provider host. If \`exchangeOAuthCode(...)\` returns
\`kind: 'host_approval_required'\`, the generated UI should:

1. show the approval link when available
2. explain which host needs approval when available
3. stop and wait for approval
4. retry only after the user approves that host in the account UI

Do not work around this by hardcoding secret values, switching to raw fetch, or
trying to bypass the approval flow.

## Recommended approval-required copy

Keep the approval-required UI direct and concrete. A good message usually says:

- Kody needs one-time permission to use the saved OAuth secret with the provider
  host
- which host needs approval when available
- where to click to approve it
- that the user should return and retry after approval

## Implementation checklist for generated UI code

Before you consider the flow complete, verify that the generated UI:

- uses a hosted saved app for browser callbacks
- creates OAuth state before redirecting
- validates the returned state on callback
- handles provider callback errors
- handles \`host_approval_required\` explicitly
- saves OAuth tokens only after a successful exchange
- tells the user the exact provider registration values they need
- avoids asking the user to paste secrets into chat

## Implementation notes for generated UI code

- Prefer hosted saved apps for OAuth callbacks.
- Prefer the built-in OAuth helpers over manual URL parsing and state storage.
- Treat \`exchangeOAuthCode(...)\` as a branching result, not just success or
  generic failure.
- Call \`saveOAuthTokens(...)\` only after a successful exchange.
- Surface approval-required results as part of the intended UX.
- If the generated UI needs secrets, collect them in the UI and save them with
  \`saveSecret(...)\` or \`saveSecrets(...)\`.
- If the provider flow depends on user-entered values that should survive a
  refresh, consider \`persistForm(...)\` and \`restoreForm(...)\`.
`.trim()

export const generatedUiOAuthGuideCapability = defineDomainCapability(
	capabilityDomainNames.coding,
	{
		name: 'generated_ui_oauth_guide',
		description:
			'Read the Kody-specific guide for implementing OAuth flows in generated UI apps. Call this before building a hosted OAuth callback flow, provider registration instructions, or secret-backed token exchange UI.',
		keywords: [
			'oauth',
			'generated ui',
			'hosted callback',
			'redirect uri',
			'provider registration',
			'host approval',
			'ui_save_app',
			'open_generated_ui',
			'window.kodyWidget',
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
