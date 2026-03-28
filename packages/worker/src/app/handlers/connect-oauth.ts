import { type BuildAction } from 'remix/fetch-router'
import { renderGeneratedUiErrorDocument } from '@kody-internal/shared/generated-ui-documents.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { renderConnectOauthPage } from '#app/connect-oauth-page.ts'
import { type routes } from '#app/routes.ts'
import { createGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'

type ConnectOauthConfig = Parameters<typeof renderConnectOauthPage>[0]['config']

const flowValues = new Set(['pkce', 'confidential'] as const)

export function createConnectOauthHandler(env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLogin(request)
			}
			const url = new URL(request.url)
			const configResult = parseConnectOauthConfig(url)
			if (!configResult.ok) {
				return renderConnectOauthError(configResult.error)
			}
			const appBaseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			const appSession = await createGeneratedUiAppSession({
				env,
				baseUrl: appBaseUrl,
				user: user.mcpUser,
				appId: null,
				homeConnectorId: null,
			})
			const html = renderConnectOauthPage({
				appBaseUrl,
				appSession,
				config: configResult.config,
			})
			return new Response(html, {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Type': 'text/html; charset=utf-8',
				},
			})
		},
	} satisfies BuildAction<
		typeof routes.connectOauth.method,
		typeof routes.connectOauth.pattern
	>
}

function renderConnectOauthError(message: string) {
	return new Response(renderGeneratedUiErrorDocument(message), {
		status: 400,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/html; charset=utf-8',
		},
	})
}

function parseConnectOauthConfig(url: URL) {
	const provider = readRequiredParam(url, 'provider')
	if (!provider) {
		return { ok: false, error: 'Missing provider query parameter.' }
	}
	const authorizeUrl = readRequiredParam(url, 'authorizeUrl')
	if (!authorizeUrl) {
		return { ok: false, error: 'Missing authorizeUrl query parameter.' }
	}
	const tokenUrl = readRequiredParam(url, 'tokenUrl')
	if (!tokenUrl) {
		return { ok: false, error: 'Missing tokenUrl query parameter.' }
	}
	const authorizeHost = safeParseHost(authorizeUrl)
	const tokenHost = safeParseHost(tokenUrl)
	if (!authorizeHost || !tokenHost) {
		return { ok: false, error: 'authorizeUrl and tokenUrl must be valid URLs.' }
	}
	const flow = (readOptionalParam(url, 'flow') ?? 'pkce').toLowerCase()
	if (!flowValues.has(flow as 'pkce' | 'confidential')) {
		return {
			ok: false,
			error: 'Invalid flow. Expected "pkce" or "confidential".',
		}
	}
	const scopes = parseScopes(readOptionalParam(url, 'scopes'))
	const scopeSeparator = readOptionalParam(url, 'scopeSeparator') ?? ' '
	const extraAuthorizeParams = parseExtraParams(
		readOptionalParam(url, 'extraAuthorizeParams'),
	)
	if (extraAuthorizeParams instanceof Error) {
		return { ok: false, error: extraAuthorizeParams.message }
	}
	const dashboardUrl = parseOptionalUrl(readOptionalParam(url, 'dashboardUrl'))
	if (dashboardUrl instanceof Error) {
		return { ok: false, error: dashboardUrl.message }
	}
	const providerKey = normalizeProviderKey(provider)
	if (!providerKey) {
		return { ok: false, error: 'Provider must contain letters or numbers.' }
	}
	const requiredHosts = normalizeAllowedHosts([authorizeHost, tokenHost])
	const config: ConnectOauthConfig = {
		authorizeUrl,
		tokenUrl,
		scopes,
		flow: flow as 'pkce' | 'confidential',
		scopeSeparator,
		extraAuthorizeParams,
		provider,
		dashboardUrl,
		clientIdValueName: `${providerKey}-client-id`,
		clientSecretSecretName:
			flow === 'confidential' ? `${providerKey}ClientSecret` : null,
		accessTokenSecretName: `${providerKey}AccessToken`,
		refreshTokenSecretName: `${providerKey}RefreshToken`,
		requiredHosts,
	}
	return { ok: true, config }
}

function normalizeProviderKey(value: string) {
	const normalized = value.trim().toLowerCase()
	return normalized.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function readRequiredParam(url: URL, key: string) {
	const value = url.searchParams.get(key)
	return value && value.trim() ? value.trim() : null
}

function readOptionalParam(url: URL, key: string) {
	const value = url.searchParams.get(key)
	return value && value.trim() ? value.trim() : null
}

function parseOptionalUrl(raw: string | null) {
	if (!raw) return null
	try {
		return new URL(raw).toString()
	} catch {
		return new Error(`Invalid URL for ${raw}.`)
	}
}

function safeParseHost(raw: string) {
	try {
		return new URL(raw).host
	} catch {
		return null
	}
}

function parseScopes(raw: string | null) {
	if (!raw) return []
	const trimmed = raw.trim()
	if (!trimmed) return []
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed)
			if (Array.isArray(parsed)) {
				return parsed.map((value) => String(value)).filter(Boolean)
			}
		} catch {}
	}
	return trimmed
		.split(/[\s,]+/)
		.map((scope) => scope.trim())
		.filter(Boolean)
}

function parseExtraParams(raw: string | null) {
	if (!raw) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return new Error('extraAuthorizeParams must be valid JSON.')
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return new Error('extraAuthorizeParams must be a JSON object.')
	}
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(parsed)) {
		if (!key || value == null) continue
		result[key] = String(value)
	}
	return result
}
