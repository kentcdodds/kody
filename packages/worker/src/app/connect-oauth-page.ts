import { escapeInlineScriptSource } from '@kody-internal/shared/generated-ui-documents.ts'
import { escapeHtmlAttribute } from '@kody-internal/shared/generated-ui-utils.ts'
import {
	buildGeneratedUiRuntimeImportMap,
	injectGeneratedUiBootstrapScript,
} from '#client/mcp-apps/generated-ui-runtime-contract.ts'
import {
	generatedUiRuntimeScriptPath,
	generatedUiRuntimeStylesheetPath,
	resolveGeneratedUiAssetUrl,
} from '@kody-internal/shared/generated-ui-asset-paths.ts'
import { type GeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'

type ConnectOauthPageConfig = {
	authorizeUrl: string
	tokenUrl: string
	scopes: Array<string>
	flow: 'pkce' | 'confidential'
	scopeSeparator: string
	extraAuthorizeParams: Record<string, string>
	provider: string
	dashboardUrl: string | null
	clientIdValueName: string
	clientSecretSecretName: string | null
	accessTokenSecretName: string
	refreshTokenSecretName: string
	requiredHosts: Array<string>
}

export function renderConnectOauthPage(input: {
	appBaseUrl: string
	appSession: GeneratedUiAppSession
	config: ConnectOauthPageConfig
}) {
	const stylesheetHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeStylesheetPath,
		input.appBaseUrl,
	)
	const runtimeScriptSrc = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeScriptPath,
		input.appBaseUrl,
	)
	const bootstrapScript = injectGeneratedUiBootstrapScript({
		mode: 'hosted',
		appSession: {
			token: input.appSession.token,
			endpoints: input.appSession.endpoints,
		},
	})
	const importMap = buildGeneratedUiRuntimeImportMap(runtimeScriptSrc)
const providerHtml = escapeHtmlAttribute(input.config.provider)
	const paramsJson = escapeInlineScriptSource(
		JSON.stringify({
			authorizeUrl: input.config.authorizeUrl,
			tokenUrl: input.config.tokenUrl,
			scopes: input.config.scopes,
			flow: input.config.flow,
			scopeSeparator: input.config.scopeSeparator,
			extraAuthorizeParams: input.config.extraAuthorizeParams,
			provider: input.config.provider,
			dashboardUrl: input.config.dashboardUrl,
			clientIdValueName: input.config.clientIdValueName,
			clientSecretSecretName: input.config.clientSecretSecretName,
			accessTokenSecretName: input.config.accessTokenSecretName,
			refreshTokenSecretName: input.config.refreshTokenSecretName,
			requiredHosts: input.config.requiredHosts,
		}),
	)
	const script = escapeInlineScriptSource(`
import { kodyWidget } from '@kody/utils'

const params = ${paramsJson}
const stateKey = \`connect-oauth:\${params.provider}\`
const pkceVerifierKey = \`\${stateKey}:pkce\`
const storage = window.sessionStorage
const root = document.querySelector('[data-connect-oauth-root]')

function $(selector) {
  return root ? root.querySelector(selector) : null
}

function setText(selector, text) {
  const el = $(selector)
  if (el) el.textContent = text
}

function setVisibility(selector, show) {
  const el = $(selector)
  if (!el) return
  el.style.display = show ? '' : 'none'
}

function updateStatus(text, tone = 'info') {
  const el = $('#status-message')
  if (!el) return
  el.textContent = text
  el.dataset.tone = tone
}

function getRedirectUri() {
  return window.location.origin + window.location.pathname
}

function hasCallback() {
  const url = new URL(window.location.href)
  return url.searchParams.has('code') || url.searchParams.has('error')
}

function isValidParamName(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function coerceStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry))
  }
  if (!value) return []
  return String(value)
    .split(/[\\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function renderExtraParams(paramsObj) {
  const entries = Object.entries(paramsObj || {})
  if (entries.length === 0) {
    setVisibility('[data-extra-params]', false)
    return
  }
  const list = $('#extra-params-list')
  if (!list) return
  list.replaceChildren()
  for (const [key, value] of entries) {
    const item = document.createElement('li')
    item.textContent = \`\${key} = \${value}\`
    list.appendChild(item)
  }
}

async function readExistingClientId() {
  try {
    const record = await kodyWidget.getValue({ name: params.clientIdValueName, scope: 'user' })
    return record?.value ?? null
  } catch {
    return null
  }
}

function renderProviderDetails() {
  setText('[data-provider-name]', params.provider)
  setText('[data-authorize-url]', params.authorizeUrl)
  setText('[data-token-url]', params.tokenUrl)
  setText('[data-flow]', params.flow === 'confidential' ? 'Confidential' : 'PKCE')
  setText('[data-scope-display]', params.scopes.length ? params.scopes.join(' ') : 'None')
  setText('[data-client-id-name]', params.clientIdValueName)
  setText('[data-client-secret-name]', params.clientSecretSecretName ?? 'Not required')
  setText('[data-access-token-name]', params.accessTokenSecretName)
  setText('[data-refresh-token-name]', params.refreshTokenSecretName || 'Not saving refresh token')
  setText('[data-redirect-uri]', getRedirectUri())
  setVisibility('[data-refresh-token-block]', Boolean(params.refreshTokenSecretName))
  setVisibility('[data-secret-row]', params.flow === 'confidential')
  if (params.dashboardUrl) {
    const link = $('[data-dashboard-link]')
    if (link) {
      link.href = params.dashboardUrl
      link.textContent = params.dashboardUrl
    }
  } else {
    setVisibility('[data-dashboard-block]', false)
  }
  renderExtraParams(params.extraAuthorizeParams)
}

function showStep(step) {
  for (const el of root ? root.querySelectorAll('[data-step]') : []) {
    el.style.display = el.getAttribute('data-step') === step ? '' : 'none'
  }
}

async function saveClientConfig(event) {
  event.preventDefault()
  const form = event.currentTarget
  const values = kodyWidget.formToObject(form)
  const clientId = typeof values.clientId === 'string' ? values.clientId.trim() : ''
  const clientSecret = typeof values.clientSecret === 'string' ? values.clientSecret.trim() : ''
  if (!clientId) {
    updateStatus('Client ID is required.', 'error')
    kodyWidget.sendMessage('Client ID is required before connecting the provider.')
    return
  }
  const tasks = [
    kodyWidget.saveValue({
      name: params.clientIdValueName,
      value: clientId,
      description: \`\${params.provider} OAuth client ID\`,
      scope: 'user',
    }),
  ]
  if (params.flow === 'confidential') {
    if (!params.clientSecretSecretName) {
      updateStatus('Missing client secret name for confidential flow.', 'error')
      kodyWidget.sendMessage(
        'Missing client secret name for confidential flow. Check the connector setup parameters.',
      )
      return
    }
    if (!clientSecret) {
      updateStatus('Client secret is required for confidential flow.', 'error')
      kodyWidget.sendMessage(
        'Client secret is required for confidential flow before connecting.',
      )
      return
    }
    tasks.push(
      kodyWidget.saveSecret({
        name: params.clientSecretSecretName,
        value: clientSecret,
        description: \`\${params.provider} OAuth client secret\`,
        scope: 'user',
      }),
    )
  }
  setVisibility('[data-secret-row]', params.flow === 'confidential')
  const results = await Promise.all(tasks)
  const failed = results.find((result) => !result.ok)
  if (failed) {
    updateStatus('Unable to save OAuth client configuration.', 'error')
    kodyWidget.sendMessage('Unable to save OAuth client configuration.')
    return
  }
  updateStatus('Saved OAuth client configuration.', 'success')
  showStep('connect')
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer)
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }
  return btoa(text).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
}

async function createCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(digest)
}

function createCodeVerifier() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function startConnect() {
  const clientId = await readExistingClientId()
  if (!clientId) {
    updateStatus('Save a client ID before connecting.', 'error')
    kodyWidget.sendMessage('Save a client ID before starting the OAuth flow.')
    showStep('setup')
    return
  }
  updateStatus('Starting OAuth flow.', 'info')
  const url = new URL(params.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', getRedirectUri())
  if (params.scopes.length > 0) {
    url.searchParams.set('scope', params.scopes.join(params.scopeSeparator))
  }
  const state = kodyWidget.createOAuthState(stateKey)
  url.searchParams.set('state', state)
  if (params.flow === 'pkce') {
    const verifier = createCodeVerifier()
    storage.setItem(pkceVerifierKey, verifier)
    const challenge = await createCodeChallenge(verifier)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('code_challenge', challenge)
  }
  for (const [key, value] of Object.entries(params.extraAuthorizeParams)) {
    if (isValidParamName(key)) {
      url.searchParams.set(key, String(value))
    }
  }
  window.location.assign(url.toString())
}

async function exchangeCode(code, returnedState) {
  const validation = kodyWidget.validateOAuthCallbackState({
    key: stateKey,
    returnedState,
  })
  if (!validation.valid) {
    updateStatus('State mismatch. Restart the OAuth flow.', 'error')
    kodyWidget.sendMessage('OAuth state mismatch. Ask the user to restart the flow.')
    return
  }
  const clientId = await readExistingClientId()
  if (!clientId) {
    updateStatus('Missing client ID. Save the OAuth configuration and retry.', 'error')
    kodyWidget.sendMessage('OAuth client ID is missing; save it and retry.')
    return
  }
  const redirectUri = getRedirectUri()
  let result = null
  if (params.flow === 'pkce') {
    const verifier = storage.getItem(pkceVerifierKey)
    if (!verifier) {
      updateStatus('Missing PKCE verifier. Restart the OAuth flow.', 'error')
      kodyWidget.sendMessage('Missing PKCE verifier in session storage. Restart the flow.')
      return
    }
    result = await kodyWidget.exchangePkceOAuthCode({
      tokenUrl: params.tokenUrl,
      code,
      redirectUri,
      clientId,
      codeVerifier: verifier,
      extraParams: params.extraAuthorizeParams,
    })
  } else {
    if (!params.clientSecretSecretName) {
      updateStatus('Missing client secret name for confidential flow.', 'error')
      kodyWidget.sendMessage('Missing client secret name for confidential flow.')
      return
    }
    result = await kodyWidget.exchangeOAuthCodeWithSecrets({
      tokenUrl: params.tokenUrl,
      code,
      redirectUri,
      clientId,
      clientSecretSecretName: params.clientSecretSecretName,
      scope: 'user',
      extraParams: params.extraAuthorizeParams,
    })
  }

  if (!result || result.ok !== true || !result.data || typeof result.data !== 'object') {
    if (result?.kind === 'host_approval_required') {
      updateStatus('Token exchange requires host approval. Approve the host and retry.', 'error')
      renderApprovalDetails(result)
      showStep('success')
      return
    }
    const message = result?.kind === 'http_error'
      ? \`Token exchange failed with HTTP status \${result.status}.\`
      : result?.message || 'Token exchange failed.'
    updateStatus(message, 'error')
    kodyWidget.sendMessage(message)
    return
  }

  const saved = await kodyWidget.saveOAuthTokens({
    payload: result.data,
    accessTokenSecretName: params.accessTokenSecretName,
    refreshTokenSecretName: params.refreshTokenSecretName || undefined,
    scope: 'user',
    accessTokenDescription: \`\${params.provider} OAuth access token\`,
    refreshTokenDescription: \`\${params.provider} OAuth refresh token\`,
  })

  if (!saved.ok) {
    updateStatus(saved.error || 'Token exchange succeeded, but saving failed.', 'error')
    kodyWidget.sendMessage(saved.error || 'Token exchange succeeded, but saving failed.')
    return
  }

  await saveConnectorConfig()
  showStep('success')
  updateStatus('OAuth tokens saved.', 'success')
  kodyWidget.sendMessage('OAuth tokens saved. Review required host approvals.')
}

async function saveConnectorConfig() {
  try {
    const result = await kodyWidget.executeCode(
      buildConnectorSaveCode({
        name: params.provider,
        tokenUrl: params.tokenUrl,
        flow: params.flow,
        clientIdValueName: params.clientIdValueName,
        clientSecretSecretName: params.clientSecretSecretName,
        accessTokenSecretName: params.accessTokenSecretName,
        refreshTokenSecretName: params.refreshTokenSecretName,
        requiredHosts: params.requiredHosts,
      }),
    )
    if (result && typeof result === 'object' && result.connector) {
      setText('[data-connector-name]', result.connector.name)
    }
  } catch (error) {
    updateStatus(
      error instanceof Error ? error.message : 'Unable to save connector config.',
      'error',
    )
    kodyWidget.sendMessage(
      error instanceof Error ? error.message : 'Unable to save connector config.',
    )
  }
}

function buildConnectorSaveCode(payload) {
  return [
    'async () => {',
    '  return await codemode.connector_save(' + JSON.stringify(payload) + ');',
    '}',
  ].join('\\n')
}

function renderApprovalDetails(result) {
  const details = $('#approval-details')
  if (!details) return
  const host = result.host || 'Unknown host'
  setText('[data-approval-host]', host)
  const names = Array.isArray(result.secretNames) ? result.secretNames : []
  setText('[data-approval-secrets]', names.length ? names.join(', ') : 'Unknown secrets')
  if (result.approvalUrl) {
    const link = $('[data-approval-link]')
    if (link) {
      link.href = result.approvalUrl
      link.textContent = result.approvalUrl
    }
    setVisibility('[data-approval-link-block]', true)
  } else {
    setVisibility('[data-approval-link-block]', false)
  }
  setVisibility('#approval-details', true)
}

async function handleCallback() {
  const callback = kodyWidget.readOAuthCallback({ expectedStateKey: stateKey })
  if (callback.kind === 'error') {
    updateStatus(
      callback.errorDescription
        ? \`\${callback.error}: \${callback.errorDescription}\`
        : \`OAuth error: \${callback.error}\`,
      'error',
    )
    return
  }
  if (callback.kind === 'success') {
    await exchangeCode(callback.code, callback.state)
  }
}

function showSetupOrConnect() {
  void readExistingClientId().then((clientId) => {
    if (clientId) {
      showStep('connect')
    } else {
      showStep('setup')
    }
  })
}

function wireEvents() {
  const form = $('#client-form')
  if (form) {
    form.addEventListener('submit', saveClientConfig)
  }
  const connectButton = $('#connect-button')
  if (connectButton) {
    connectButton.addEventListener('click', () => {
      void startConnect()
    })
  }
  const retryButton = $('#retry-button')
  if (retryButton) {
    retryButton.addEventListener('click', () => {
      showSetupOrConnect()
      updateStatus('Ready to retry.', 'info')
    })
  }
}

function renderRequiredHosts() {
  const list = $('#required-hosts')
  if (!list) return
  list.replaceChildren()
  if (!params.requiredHosts.length) {
    const item = document.createElement('li')
    item.textContent = 'No hosts declared.'
    list.appendChild(item)
    return
  }
  for (const host of params.requiredHosts) {
    const item = document.createElement('li')
    item.textContent = host
    list.appendChild(item)
  }
}

async function init() {
  renderProviderDetails()
  renderRequiredHosts()
  wireEvents()
  if (hasCallback()) {
    showStep('callback')
    await handleCallback()
  } else {
    showSetupOrConnect()
  }
}

init()
`)

	return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect ${providerHtml}</title>
    <link rel="stylesheet" href="${stylesheetHref}" />
    ${bootstrapScript}
    ${importMap}
    <script type="module" src="${runtimeScriptSrc}"></script>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        background: #0b1120;
        color: #e2e8f0;
      }
      main {
        max-width: 780px;
        margin: 0 auto;
        padding: 40px 24px 80px;
        display: grid;
        gap: 24px;
      }
      h1, h2, h3 {
        margin: 0;
      }
      .card {
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 16px;
        padding: 24px;
        display: grid;
        gap: 16px;
        box-shadow: 0 24px 48px rgba(15, 23, 42, 0.3);
      }
      label {
        display: grid;
        gap: 6px;
        font-weight: 600;
      }
      input {
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid rgba(148, 163, 184, 0.3);
        background: rgba(2, 6, 23, 0.7);
        color: inherit;
      }
      button {
        padding: 10px 16px;
        border-radius: 999px;
        border: none;
        background: #2563eb;
        color: white;
        font-weight: 600;
        cursor: pointer;
      }
      button.secondary {
        background: rgba(148, 163, 184, 0.2);
        color: #e2e8f0;
      }
      .status {
        padding: 12px 16px;
        border-radius: 12px;
        border: 1px solid transparent;
      }
      .status[data-tone="error"] {
        border-color: rgba(248, 113, 113, 0.6);
        background: rgba(248, 113, 113, 0.12);
      }
      .status[data-tone="success"] {
        border-color: rgba(34, 197, 94, 0.6);
        background: rgba(34, 197, 94, 0.12);
      }
      .status[data-tone="info"] {
        border-color: rgba(59, 130, 246, 0.4);
        background: rgba(59, 130, 246, 0.12);
      }
      code, pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.18);
        font-size: 12px;
      }
      .grid {
        display: grid;
        gap: 12px;
      }
      .split {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }
      a {
        color: #60a5fa;
      }
    </style>
  </head>
  <body>
    <main data-connect-oauth-root>
      <header class="grid">
        <h1>Connect <span data-provider-name></span></h1>
        <p>Follow the steps below to connect your account using OAuth.</p>
      </header>

      <section class="status" id="status-message" data-tone="info">
        Ready to connect.
      </section>

      <section class="card">
        <h2>Provider details</h2>
        <div class="split">
          <div class="grid">
            <div class="pill">Authorize URL: <code data-authorize-url></code></div>
            <div class="pill">Token URL: <code data-token-url></code></div>
            <div class="pill">Flow: <span data-flow></span></div>
          </div>
          <div class="grid">
            <div class="pill">Client ID value: <code data-client-id-name></code></div>
            <div class="pill">Client secret: <code data-client-secret-name></code></div>
            <div class="pill">Scope: <span data-scope-display></span></div>
          </div>
        </div>
        <div class="grid" data-dashboard-block>
          <span>Provider dashboard</span>
          <a data-dashboard-link href="#" rel="noopener noreferrer" target="_blank"></a>
        </div>
        <div class="grid">
          <span>Redirect URI to register</span>
          <code data-redirect-uri></code>
        </div>
        <div class="grid" data-extra-params>
          <span>Extra authorize params</span>
          <ul id="extra-params-list"></ul>
        </div>
      </section>

      <section class="card" data-step="setup">
        <h2>1. Save OAuth client configuration</h2>
        <p>Store the client ID (and secret for confidential flows) in your account.</p>
        <form id="client-form" class="grid">
          <label>
            Client ID
            <input name="clientId" autocomplete="off" required />
          </label>
          <label data-secret-row>
            Client Secret
            <input name="clientSecret" type="password" autocomplete="off" />
          </label>
          <button type="submit">Save configuration</button>
        </form>
      </section>

      <section class="card" data-step="connect" style="display:none;">
        <h2>2. Connect</h2>
        <p>Start the OAuth flow. You will be redirected to the provider.</p>
        <button id="connect-button">Connect ${providerHtml}</button>
      </section>

      <section class="card" data-step="callback" style="display:none;">
        <h2>3. Finishing up</h2>
        <p>Completing the OAuth callback and saving tokens.</p>
      </section>

      <section class="card" data-step="success" style="display:none;">
        <h2>4. Success</h2>
        <div class="grid">
          <p>Saved connector: <strong data-connector-name>${providerHtml}</strong></p>
          <div class="grid">
            <span>Access token secret</span>
            <code data-access-token-name></code>
          </div>
          <div class="grid" data-refresh-token-block>
            <span>Refresh token secret</span>
            <code data-refresh-token-name></code>
          </div>
        </div>
        <div class="grid">
          <h3>Host approvals required</h3>
          <p>Hosts are <strong>never</strong> auto-approved. Approve them explicitly in your account secrets.</p>
          <ul id="required-hosts"></ul>
        </div>
        <div class="grid" id="approval-details" style="display:none;">
          <h3>Approval needed to complete token exchange</h3>
          <p>Host <code data-approval-host></code> must be approved for secrets: <code data-approval-secrets></code></p>
          <div data-approval-link-block>
            <a data-approval-link href="#" target="_blank" rel="noopener noreferrer"></a>
          </div>
        </div>
        <div class="grid">
          <a href="/account/secrets" target="_blank" rel="noopener noreferrer">Open account secrets</a>
          <button class="secondary" id="retry-button" type="button">Connect another account</button>
        </div>
      </section>
    </main>
    <script type="module">${script}</script>
  </body>
</html>
	`.trim()
}
