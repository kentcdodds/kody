import { type BuildAction } from 'remix/fetch-router'
import {
	generatedUiRuntimeScriptPath,
	generatedUiRuntimeStylesheetPath,
	resolveGeneratedUiAssetUrl,
} from '@kody-internal/shared/generated-ui-asset-paths.ts'
import { renderGeneratedUiDocument } from '@kody-internal/shared/generated-ui-documents.ts'
import {
	buildGeneratedUiRuntimeImportMap,
	injectGeneratedUiBootstrapScript,
	type GeneratedUiRuntimeBootstrap,
} from '#client/mcp-apps/generated-ui-runtime-contract.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import {
	createGeneratedUiAppSession,
	verifyGeneratedUiAppSession,
} from '#mcp/generated-ui-app-session.ts'
import {
	listSecrets,
	resolveSecret,
} from '#mcp/secrets/service.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { secretScopeValues, type SecretScope } from '#mcp/secrets/types.ts'
import { saveValue } from '#mcp/values/service.ts'
import { type routes } from '#app/routes.ts'

export function createConnectSecretHandler(env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLogin(request)
			}

			const url = new URL(request.url)
			const scope = readSecretScope(url)
			const connector = readConnectorParam(url)
			const name = readNameParam(url)
			const appId =
				scope === 'app'
					? buildConnectSecretAppId({ connector, name })
					: null
			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			const appSession = await createGeneratedUiAppSession({
				env,
				baseUrl,
				user: user.mcpUser,
				appId,
				homeConnectorId: null,
			})
			const html = renderGeneratedUiDocument({
				code: buildConnectSecretClientScript(),
				runtime: 'javascript',
				headInjection: buildHeadInjection({
					appSession,
					appBaseUrl: baseUrl,
				}),
				baseHref: baseUrl,
			})
			return new Response(html, {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': 'text/html; charset=utf-8',
				},
			})
		},
	} satisfies BuildAction<
		typeof routes.connectSecret.method,
		typeof routes.connectSecret.pattern
	>
}

export function createConnectSecretApiHandler(env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}
			const name = readString(body, 'name')
			const scope = readScope(body)
			const sessionToken = readString(body, 'sessionToken')
			if (!name) {
				return jsonResponse({ ok: false, error: 'Secret name is required.' }, 400)
			}
			if (!scope) {
				return jsonResponse({ ok: false, error: 'Secret scope is required.' }, 400)
			}
			if (!sessionToken) {
				return jsonResponse(
					{ ok: false, error: 'Session token is required.' },
					400,
				)
			}
			const connector = readOptionalString(body, 'connector')
			const requestedAllowedHosts =
				readOptionalStringArray(body, 'allowedHosts') ?? []
			let session
			try {
				session = await verifyGeneratedUiAppSession(env, sessionToken)
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Invalid session token.',
					},
					401,
				)
			}
			if (session.user.userId !== user.mcpUser.userId) {
				return jsonResponse({ ok: false, error: 'User mismatch.' }, 403)
			}
			const storageContext = {
				sessionId: session.session_id,
				appId: session.app_id ?? null,
			}

			try {
				const resolved = await resolveSecret({
					env,
					userId: user.mcpUser.userId,
					name,
					scope,
					storageContext,
				})
				if (!resolved.found) {
					return jsonResponse(
						{ ok: false, error: 'Secret not found.' },
						404,
					)
				}
				if (connector) {
					const allowedHosts =
						requestedAllowedHosts && requestedAllowedHosts.length > 0
							? normalizeAllowedHosts(requestedAllowedHosts)
							: resolved.allowedHosts
					await saveValue({
						env,
						userId: user.mcpUser.userId,
						name: `_connector:${connector}`,
						value: JSON.stringify({
							secretName: name,
							allowedHosts,
						}),
						description: `Connector secret config for ${connector}`,
						scope,
						storageContext,
					})
				}
				return jsonResponse({ ok: true })
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update connector configuration.',
					},
					400,
				)
			}
		},
	} satisfies BuildAction<
		typeof routes.connectSecretApi.method,
		typeof routes.connectSecretApi.pattern
	>
}

function readSecretScope(url: URL): SecretScope {
	const raw = url.searchParams.get('scope')
	return secretScopeValues.includes(raw as SecretScope)
		? (raw as SecretScope)
		: 'user'
}

function readConnectorParam(url: URL) {
	const value = url.searchParams.get('connector')
	return value?.trim() ? value.trim() : null
}

function readNameParam(url: URL) {
	const value = url.searchParams.get('name')
	return value?.trim() ? value.trim() : null
}

function buildConnectSecretAppId(input: {
	connector: string | null
	name: string | null
}) {
		if (input.connector) {
			return `_connector:${input.connector}`
		}
		return input.name ? `connect-secret:${input.name}` : null
}

function buildHeadInjection(input: {
	appSession: Awaited<ReturnType<typeof createGeneratedUiAppSession>>
	appBaseUrl: string
}) {
	const stylesheetHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeStylesheetPath,
		input.appBaseUrl,
	)
	const runtimeScriptHref = resolveGeneratedUiAssetUrl(
		generatedUiRuntimeScriptPath,
		input.appBaseUrl,
	)
	const bootstrap: GeneratedUiRuntimeBootstrap = {
		mode: 'hosted',
		appSession: {
			token: input.appSession.token,
			endpoints: input.appSession.endpoints,
		},
	}
	return `
<link rel="stylesheet" href="${stylesheetHref}" />
${injectGeneratedUiBootstrapScript(bootstrap)}
${buildGeneratedUiRuntimeImportMap(runtimeScriptHref)}
<script type="module" src="${runtimeScriptHref}"></script>
	`.trim()
}

function buildConnectSecretClientScript() {
	return `
import { kodyWidget, whenKodyWidgetReady } from '@kody/utils'

const root =
  document.querySelector('[data-generated-ui-root]') ?? document.body

const state = {
  step: 'loading',
  error: '',
  secretValue: '',
  existingSecret: null,
  updateConfirmed: false,
  confirmedReview: false,
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function parseQuery() {
  const url = new URL(window.location.href)
  const name = url.searchParams.get('name')
  const description = url.searchParams.get('description')
  const instructions = url.searchParams.get('instructions')
  const dashboardUrl = url.searchParams.get('dashboardUrl')
  const connector = url.searchParams.get('connector')
  const rawScope = url.searchParams.get('scope')
  const scope =
    rawScope === 'app' || rawScope === 'session' || rawScope === 'user'
      ? rawScope
      : 'user'
  const allowedHosts = (url.searchParams.get('allowedHosts') || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  const allowedCapabilities = (url.searchParams.get('allowedCapabilities') || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return {
    name: name && name.trim() ? name.trim() : '',
    description: description && description.trim() ? description.trim() : '',
    instructions: instructions && instructions.trim() ? instructions.trim() : '',
    dashboardUrl: dashboardUrl && dashboardUrl.trim() ? dashboardUrl.trim() : '',
    connector: connector && connector.trim() ? connector.trim() : '',
    scope,
    allowedHosts: Array.from(new Set(allowedHosts)).sort(),
    allowedCapabilities: Array.from(new Set(allowedCapabilities)).sort((a, b) =>
      a.localeCompare(b),
    ),
  }
}

function scopeLabel(scope) {
  if (scope === 'session') return 'Session (expires when this session ends)'
  if (scope === 'app') return 'App'
  return 'User'
}

function renderList(items, emptyLabel) {
  if (!items || items.length === 0) {
    return '<span class="muted">' + escapeHtml(emptyLabel) + '</span>'
  }
  return (
    '<ul class="list">' +
    items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') +
    '</ul>'
  )
}

function renderInstructions(params) {
  if (!params.instructions && !params.dashboardUrl) {
    return '<p class="muted">Enter the secret value below.</p>'
  }
  const instructions = params.instructions
    ? '<p class="instructions">' + escapeHtml(params.instructions) + '</p>'
    : ''
  const dashboard =
    params.dashboardUrl && isSafeUrl(params.dashboardUrl)
      ? '<a class="link" href="' +
        escapeHtml(params.dashboardUrl) +
        '" target="_blank" rel="noopener noreferrer">Open provider settings</a>'
      : ''
  return (
    '<div class="instructions-block">' +
    instructions +
    dashboard +
    '</div>'
  )
}

function renderExistingSecret(existing) {
  if (!existing) return ''
  return (
    '<div class="card">' +
    '<h3>Secret already exists</h3>' +
    '<p class="muted">A secret named <strong>' +
    escapeHtml(existing.name) +
    '</strong> already exists in the ' +
    escapeHtml(existing.scope) +
    ' scope. Updating will replace the stored value.</p>' +
    '<div class="grid-two">' +
    '<div>' +
    '<div class="label">Current allowed hosts</div>' +
    renderList(existing.allowed_hosts, 'None') +
    '</div>' +
    '<div>' +
    '<div class="label">Current allowed capabilities</div>' +
    renderList(existing.allowed_capabilities, 'None') +
    '</div>' +
    '</div>' +
    '</div>'
  )
}

function renderReview(params) {
  return (
    '<div class="card">' +
    '<h3>Review before saving</h3>' +
    '<div class="review-grid">' +
    '<div><span class="label">Secret name</span><div>' +
    escapeHtml(params.name) +
    '</div></div>' +
    '<div><span class="label">Scope</span><div>' +
    escapeHtml(scopeLabel(params.scope)) +
    '</div></div>' +
    '</div>' +
    (params.description
      ? '<div><span class="label">Description</span><div>' +
        escapeHtml(params.description) +
        '</div></div>'
      : '') +
    '<div class="grid-two">' +
    '<div><span class="label">Approved hosts</span>' +
    renderList(params.allowedHosts, 'None (approval required later).') +
    '</div>' +
    '<div><span class="label">Approved capabilities</span>' +
    renderList(params.allowedCapabilities, 'No restrictions requested.') +
    '</div>' +
    '</div>' +
    '<p class="muted">The secret value stays hidden and cannot be viewed later.</p>' +
    '</div>'
  )
}

function render() {
  const params = parseQuery()
  if (!params.name) {
    root.innerHTML =
      '<div class="connect-secret"><div class="card"><h2>Missing secret name</h2>' +
      '<p class="muted">Provide a name query parameter to continue.</p></div></div>'
    return
  }

  const content = []
  content.push('<div class="connect-secret">')
  content.push('<header class="page-header">')
  content.push('<div class="eyebrow">Kody secure connection</div>')
  content.push('<h1>Save a secret</h1>')
  if (params.description) {
    content.push('<p class="muted">' + escapeHtml(params.description) + '</p>')
  } else {
    content.push(
      '<p class="muted">This keeps your credentials private and out of chat logs.</p>',
    )
  }
  content.push('</header>')

  if (state.step === 'loading') {
    content.push('<p class="muted">Loading secret details…</p>')
    content.push('</div>')
    root.innerHTML = content.join('')
    return
  }

  if (state.step === 'update-confirm' && state.existingSecret) {
    content.push(renderExistingSecret(state.existingSecret))
    content.push(
      '<div class="button-row">' +
        '<button class="primary" data-action="confirm-update">Update secret</button>' +
        '<button class="secondary" data-action="cancel-update">Cancel</button>' +
      '</div>',
    )
    content.push('</div>')
    root.innerHTML = content.join('')
    attachHandlers()
    return
  }

  if (state.step === 'cancelled') {
    content.push(
      '<div class="card"><h3>Cancelled</h3><p class="muted">No changes were made. You can close this tab.</p></div>',
    )
    content.push('</div>')
    root.innerHTML = content.join('')
    return
  }

  if (state.step === 'success') {
    content.push(
      '<div class="card"><h3>Secret saved</h3><p class="muted">You can close this tab now.</p></div>',
    )
    content.push('</div>')
    root.innerHTML = content.join('')
    return
  }

  if (state.step === 'error') {
    content.push(
      '<div class="card"><h3>Something went wrong</h3><p class="muted">' +
        escapeHtml(state.error || 'Unable to save the secret.') +
        '</p></div>',
    )
    content.push(
      '<div class="button-row"><button class="secondary" data-action="back">Back</button></div>',
    )
    content.push('</div>')
    root.innerHTML = content.join('')
    attachHandlers()
    return
  }

  content.push('<section class="card">')
  content.push('<h2>Instructions</h2>')
  content.push(renderInstructions(params))
  if (params.dashboardUrl && !isSafeUrl(params.dashboardUrl)) {
    content.push(
      '<p class="muted">The provided dashboard link is invalid.</p>',
    )
  }
  content.push('</section>')

  if (state.existingSecret && state.updateConfirmed) {
    content.push(renderExistingSecret(state.existingSecret))
  }

  content.push('<section class="card">')
  content.push('<h2>Enter secret</h2>')
  content.push(
    '<label>' +
      '<span class="label">Secret value</span>' +
      '<input type="password" autocomplete="new-password" name="secretValue" value="' +
      escapeHtml(state.secretValue) +
      '" placeholder="Paste the secret value" />' +
      '</label>',
  )
  content.push('</section>')

  if (state.step === 'review') {
    content.push(renderReview(params))
    content.push(
      '<label class="confirm-row"><input type="checkbox" name="confirmReview"' +
        (state.confirmedReview ? ' checked' : '') +
        ' /> I confirm these details are correct.</label>',
    )
  }

  if (state.step === 'saving') {
    content.push('<p class="muted">Saving secret…</p>')
  }

  content.push('<div class="button-row">')
  if (state.step === 'review') {
    content.push('<button class="secondary" data-action="back">Back</button>')
    content.push(
      '<button class="primary" data-action="save" ' +
        (state.confirmedReview ? '' : 'disabled') +
        '>Save secret</button>',
    )
  } else {
    content.push('<button class="primary" data-action="review">Review</button>')
  }
  content.push('</div>')
  content.push('</div>')
  root.innerHTML = content.join('')
  attachHandlers()
}

function attachHandlers() {
  const params = parseQuery()
  const input = root.querySelector('input[name="secretValue"]')
  if (input) {
    input.addEventListener('input', (event) => {
      state.secretValue = event.currentTarget.value
    })
  }
  const confirmBox = root.querySelector('input[name="confirmReview"]')
  if (confirmBox) {
    confirmBox.addEventListener('change', (event) => {
      state.confirmedReview = event.currentTarget.checked
      render()
    })
  }
  root.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const action = event.currentTarget.getAttribute('data-action')
      if (action === 'confirm-update') {
        state.updateConfirmed = true
        state.step = 'input'
        render()
        return
      }
      if (action === 'cancel-update') {
        state.step = 'cancelled'
        render()
        return
      }
      if (action === 'review') {
        if (!state.secretValue.trim()) {
          state.error = 'Enter the secret value before continuing.'
          state.step = 'error'
          render()
          return
        }
        state.confirmedReview = false
        state.step = 'review'
        render()
        return
      }
      if (action === 'back') {
        state.step = 'input'
        state.error = ''
        render()
        return
      }
      if (action === 'save') {
        if (!state.confirmedReview) return
        await handleSave(params)
      }
    })
  })
}

async function handleSave(params) {
  state.step = 'saving'
  state.error = ''
  render()
  try {
    const saved = await kodyWidget.saveSecret({
      name: params.name,
      value: state.secretValue,
      description: params.description,
      scope: params.scope,
    })
    if (!saved.ok) {
      throw new Error(saved.error || 'Unable to save secret.')
    }
    await updateSecretPolicies(params)
    state.step = 'success'
  } catch (error) {
    state.error = error instanceof Error ? error.message : 'Unable to save secret.'
    state.step = 'error'
  }
  render()
}

async function updateSecretPolicies(params) {
  if (!params.connector) return
  if (params.scope !== 'app') {
    throw new Error('Connector secrets must use the app scope.')
  }
  const sessionToken =
    window.__kodyGeneratedUiBootstrap?.appSession?.token ?? null
  if (!sessionToken) {
    throw new Error('Missing session token. Refresh the page and retry.')
  }
  const response = await fetch('/connect/secret.json', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      name: params.name,
      scope: params.scope,
      sessionToken,
      connector: params.connector,
      allowedHosts: params.allowedHosts,
    }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok) {
    const message =
      typeof payload?.error === 'string'
        ? payload.error
        : 'Unable to update connector config.'
    throw new Error(message)
  }
}

function isSafeUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function injectStyles() {
  const style = document.createElement('style')
  style.textContent = [
    '.connect-secret {',
    '  max-width: 720px;',
    '  margin: 0 auto;',
    '  display: grid;',
    '  gap: var(--spacing-6);',
    '  padding: var(--spacing-6);',
    '}',
    '.page-header { display: grid; gap: var(--spacing-2); }',
    '.eyebrow {',
    '  font-size: 0.75rem;',
    '  text-transform: uppercase;',
    '  letter-spacing: 0.08em;',
    '  color: var(--color-muted);',
    '}',
    '.card {',
    '  padding: var(--spacing-4);',
    '  background: var(--color-surface);',
    '  border: 1px solid var(--color-border);',
    '  border-radius: var(--radius-3);',
    '  box-shadow: var(--shadow-1);',
    '  display: grid;',
    '  gap: var(--spacing-3);',
    '}',
    '.label {',
    '  font-weight: 600;',
    '  font-size: 0.85rem;',
    '  color: var(--color-muted);',
    '}',
    '.muted { color: var(--color-muted); }',
    '.instructions { white-space: pre-wrap; }',
    '.instructions-block { display: grid; gap: var(--spacing-3); }',
    '.button-row { display: flex; gap: var(--spacing-3); flex-wrap: wrap; }',
    'button.secondary {',
    '  background: transparent;',
    '  color: var(--color-fg);',
    '  border: 1px solid var(--color-border);',
    '}',
    '.list { margin: var(--spacing-2) 0 0; padding-left: 1.25rem; }',
    '.review-grid {',
    '  display: grid;',
    '  grid-template-columns: repeat(2, minmax(0, 1fr));',
    '  gap: var(--spacing-3);',
    '}',
    '.grid-two {',
    '  display: grid;',
    '  grid-template-columns: repeat(2, minmax(0, 1fr));',
    '  gap: var(--spacing-3);',
    '}',
    '.confirm-row {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: var(--spacing-2);',
    '  font-weight: 500;',
    '}',
    '@media (max-width: 640px) {',
    '  .connect-secret { padding: var(--spacing-4); }',
    '  .review-grid, .grid-two { grid-template-columns: 1fr; }',
    '}',
  ].join('\\n')
  document.head.appendChild(style)
}

async function initialize() {
  injectStyles()
  const params = parseQuery()
  if (!params.name) {
    render()
    return
  }
  await whenKodyWidgetReady()
  try {
    const secrets = await kodyWidget.listSecrets({ scope: params.scope })
    const existing = secrets.find((secret) => secret.name === params.name)
    state.existingSecret = existing ?? null
    state.step = existing ? 'update-confirm' : 'input'
  } catch (error) {
    state.error =
      error instanceof Error
        ? error.message
        : 'Unable to load existing secrets.'
    state.step = 'error'
  }
  render()
}

void initialize()
	`.trim()
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalStringArray(body: object, key: string) {
	if (!Object.hasOwn(body, key)) return null
	const value = (body as Record<string, unknown>)[key]
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string')
}

function readScope(body: object): SecretScope | null {
	const raw = readString(body, 'scope')
	return raw && secretScopeValues.includes(raw as SecretScope)
		? (raw as SecretScope)
		: null
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
