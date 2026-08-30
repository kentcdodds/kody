import {
	normalizeProviderKey,
	safeParseHost,
} from '@kody-internal/shared/url-hosts.ts'
import {
	type AccountIntegrationDetailLoaderData,
	type ConnectOauthLoaderData,
} from '#universal/loader-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	pageEyebrowCss,
	pageHeaderCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { accountDisclosureCss } from './account-management-components.tsx'
import {
	type ConnectOauthConfig,
	type ConnectOauthQueryConfig,
	createCodeChallenge,
	createCodeVerifier,
	formatOAuthExchangeFailure,
	isSafeExternalUrl,
	normalizeHosts,
	parseAllowedHosts,
	parseExtraParams,
	parseOptionalBoolean,
	parseOptionalUrl,
	parseProviderSetupInstructions,
	parseScopes,
	parseSessionConnectOauthConfig,
	parseTokenExchangeStyle,
} from './connect-oauth-config.ts'

export type ConnectOauthStatusTone = 'info' | 'warn' | 'error'
export type ConnectOauthStep = 'setup' | 'connect' | 'callback' | 'success'

export type OAuthExchangeResult =
	| { ok: true; data: Record<string, unknown>; status: number }
	| { ok: false; status: number; error: string }

export type SaveSecretResult = { ok: true } | { ok: false; error: string }

export type SaveOauthAppResult =
	| { ok: true; clientId: string }
	| { ok: false; error: string }

export type OAuthCallback =
	| { kind: 'none' }
	| { kind: 'error'; error: string; description: string | null }
	| { kind: 'success'; code: string; state: string | null }

export type ConnectOauthQueryConfigResult =
	| { ok: true; value: ConnectOauthQueryConfig }
	| { ok: false; error: string }

export type ConnectOauthChooserOption = NonNullable<
	ConnectOauthLoaderData['chooser']
>['options'][number]

export const emptyConnectOauthLoaderData: ConnectOauthLoaderData = {
	ok: true,
	provider: null,
	integration: null,
	chooser: { options: [] },
}

export const connectOauthConfigStorageKey = 'connect-oauth:config'

const reservedAuthorizeParams = new Set([
	'client_id',
	'code_challenge',
	'code_challenge_method',
	'redirect_uri',
	'response_type',
	'scope',
	'state',
])

export function buildConnectOauthIntegrationLookupHref(
	providerKey: string,
	searchParams: URLSearchParams,
) {
	const params = new URLSearchParams({ name: providerKey })
	const platform = searchParams.get('platform')?.trim()
	if (platform) params.set('platform', platform)
	const app = searchParams.get('app')?.trim()
	if (app) params.set('app', app)
	return `/account/integrations.json?${params.toString()}`
}

/**
 * SPA-navigation prefetch mirroring the server handler's SSR embed: the
 * stored or built-in record for `?provider=` visits, resolved before the
 * route renders. Callback returns (`code`/`error`) restore config from
 * sessionStorage and bare visits redirect server-side, so both prefetch
 * nothing.
 */
export async function connectOauthRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const params = url.searchParams
	const provider = params.get('provider')?.trim()
	if (params.get('code') || params.get('error')) {
		return { connectOauth: emptyConnectOauthLoaderData }
	}
	if (!provider) {
		const response = await fetch(
			'/account/integrations.json?connectChooser=1',
			{
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			},
		)
		if (response.status === 401) {
			return routeLoaderRedirect('/login')
		}
		const payload = (await response.json().catch(() => null)) as {
			ok?: boolean
			chooser?: ConnectOauthLoaderData['chooser']
		} | null
		return {
			connectOauth: {
				ok: true,
				provider: null,
				integration: null,
				chooser:
					response.ok && payload?.ok === true && payload.chooser
						? payload.chooser
						: { options: [] },
			},
		}
	}
	const providerKey = normalizeProviderKey(provider)
	if (!providerKey) {
		return { connectOauth: emptyConnectOauthLoaderData }
	}
	const response = await fetch(
		buildConnectOauthIntegrationLookupHref(providerKey, params),
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountIntegrationDetailLoaderData>(response)
	return {
		connectOauth: {
			ok: true,
			provider: providerKey,
			integration:
				response.ok && payload?.ok ? (payload.integration ?? null) : null,
			builtInAvailable:
				response.ok && payload?.ok
					? (payload.builtInAvailable ?? false)
					: false,
			existingConnection:
				response.ok && payload?.ok
					? (payload.existingConnection ?? null)
					: null,
			hasStoredClientSecret:
				response.ok && payload?.ok
					? (payload.hasStoredClientSecret ?? false)
					: false,
		},
	}
}

export function readConnectOauthQueryConfig(
	url: URL,
): ConnectOauthQueryConfigResult {
	const readRequired = (key: string) => {
		const value = url.searchParams.get(key)
		return value && value.trim() ? value.trim() : null
	}
	const readOptional = (key: string) => {
		const value = url.searchParams.get(key)
		return value && value.trim() ? value.trim() : null
	}
	const provider = readRequired('provider')
	const authorizeUrl = readOptional('authorizeUrl')
	const tokenUrl = readOptional('tokenUrl')
	const apiBaseUrl = parseOptionalUrl(readOptional('apiBaseUrl'))
	if (!provider) {
		return {
			ok: false,
			error: 'Missing required OAuth configuration parameters.',
		}
	}
	const authorizeHost = authorizeUrl ? safeParseHost(authorizeUrl) : null
	if (authorizeUrl && (!isSafeExternalUrl(authorizeUrl) || !authorizeHost)) {
		return { ok: false, error: 'Authorize URL must be valid.' }
	}
	const tokenHost = tokenUrl ? safeParseHost(tokenUrl) : null
	if (tokenUrl && !tokenHost) {
		return { ok: false, error: 'Token URL must be valid when provided.' }
	}
	const rawFlow = readOptional('flow')?.toLowerCase() ?? null
	const flow = rawFlow === 'pkce' || rawFlow === 'confidential' ? rawFlow : null
	const usePkce = parseOptionalBoolean(readOptional('pkce'))
	const tokenExchangeStyle = parseTokenExchangeStyle(
		readOptional('tokenExchangeStyle'),
	)
	const rawScopes = readOptional('scopes')
	const scopes = rawScopes == null ? null : parseScopes(rawScopes)
	const scopeSeparator = readOptional('scopeSeparator')
	const rawExtraAuthorizeParams = readOptional('extraAuthorizeParams')
	const extraAuthorizeParams =
		rawExtraAuthorizeParams == null
			? null
			: parseExtraParams(rawExtraAuthorizeParams)
	const dashboardUrl = parseOptionalUrl(readOptional('dashboardUrl'))
	const loginHint = readOptional('loginHint')
	const providerKey = normalizeProviderKey(provider)
	if (!providerKey) {
		return { ok: false, error: 'Provider must contain letters or numbers.' }
	}
	const providerSetupInstructions = parseProviderSetupInstructions(
		readOptional('providerSetupInstructions'),
	)
	const allowedHosts = normalizeHosts([
		...(tokenHost ? [tokenHost] : []),
		...parseAllowedHosts(readOptional('allowedHosts')),
	])
	return {
		ok: true,
		value: {
			provider,
			providerKey,
			authorizeHost,
			authorizeUrl,
			tokenUrl,
			apiBaseUrl,
			scopes,
			flow,
			usePkce,
			tokenExchangeStyle,
			scopeSeparator,
			extraAuthorizeParams,
			providerSetupInstructions,
			dashboardUrl,
			allowedHosts,
			loginHint,
		},
	}
}

export function readConnectOauthCallback(): OAuthCallback {
	if (typeof window === 'undefined') return { kind: 'none' }
	const params = new URLSearchParams(window.location.search)
	const error = params.get('error')
	const description = params.get('error_description')
	if (error) {
		return { kind: 'error', error, description }
	}
	const code = params.get('code')
	if (!code) return { kind: 'none' }
	return { kind: 'success', code, state: params.get('state') }
}

export function getConnectOauthRedirectUri(ssrRedirectUri: string | null) {
	if (typeof window === 'undefined') return ssrRedirectUri ?? ''
	return `${window.location.origin}${window.location.pathname}`
}

export function getConnectOauthStateKey(providerKey: string) {
	return `connect-oauth:${providerKey}`
}

export function getConnectOauthPkceKey(providerKey: string) {
	return `connect-oauth:${providerKey}:pkce`
}

export function persistConnectOauthConfig(nextConfig: ConnectOauthConfig) {
	try {
		sessionStorage.setItem(
			connectOauthConfigStorageKey,
			JSON.stringify(nextConfig),
		)
	} catch {
		// Config caching is best-effort; the required OAuth state write below still fails visibly.
	}
}

export function readStoredConnectOauthConfig(): ConnectOauthConfig | null {
	if (typeof window === 'undefined') return null
	const raw = sessionStorage.getItem(connectOauthConfigStorageKey)
	if (!raw) return null
	return parseSessionConnectOauthConfig(raw)
}

export function createConnectOauthState(key: string) {
	const value = crypto.randomUUID()
	sessionStorage.setItem(key, value)
	return value
}

export function validateConnectOauthState(
	key: string,
	returned: string | null,
) {
	const expected = sessionStorage.getItem(key)
	return Boolean(expected && returned && expected === returned)
}

export async function buildConnectOauthAuthorizeUrl(input: {
	config: ConnectOauthConfig
	hasConfigError: boolean
	redirectUri: string
}) {
	if (input.hasConfigError) {
		throw new Error('Unable to start OAuth with invalid configuration.')
	}
	persistConnectOauthConfig(input.config)
	const url = new URL(input.config.authorizeUrl)
	url.searchParams.set('response_type', 'code')
	const clientId = input.config.clientId.trim()
	if (!clientId) {
		throw new Error('Missing client ID. Save it before connecting.')
	}
	url.searchParams.set('client_id', clientId)
	url.searchParams.set('redirect_uri', input.redirectUri)
	if (input.config.scopes.length > 0) {
		url.searchParams.set(
			'scope',
			input.config.scopes.join(input.config.scopeSeparator),
		)
	}
	const state = createConnectOauthState(
		getConnectOauthStateKey(input.config.providerKey),
	)
	url.searchParams.set('state', state)
	if (input.config.usePkce) {
		const verifier = createCodeVerifier()
		sessionStorage.setItem(
			getConnectOauthPkceKey(input.config.providerKey),
			verifier,
		)
		const challenge = await createCodeChallenge(verifier)
		url.searchParams.set('code_challenge_method', 'S256')
		url.searchParams.set('code_challenge', challenge)
	}
	for (const [key, value] of Object.entries(
		input.config.extraAuthorizeParams,
	)) {
		if (!key) continue
		if (reservedAuthorizeParams.has(key.toLowerCase())) continue
		url.searchParams.set(key, value)
	}
	return url.toString()
}

/**
 * An expired session must land the user on the login page instead of a
 * generic "Unable to save ..." error mid-flow.
 */
export function redirectToLoginOn401(response: Response) {
	if (response.status !== 401) return false
	window.location.assign('/login')
	return true
}

export async function saveConnectOauthSecret(
	name: string,
	value: string,
	description: string,
	allowedHosts: Array<string>,
): Promise<SaveSecretResult> {
	const response = await fetch('/account/secrets.json', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({
			action: 'save',
			name,
			value,
			scope: 'user',
			description,
			allowedHosts,
		}),
	})
	if (redirectToLoginOn401(response)) {
		return { ok: false, error: 'Session expired.' }
	}
	const payload = await response.json().catch(() => null)
	if (!response.ok || payload?.ok !== true) {
		return { ok: false, error: payload?.error || 'Unable to save secret.' }
	}
	return { ok: true }
}

export async function exchangeConnectOauthCode(
	nextConfig: ConnectOauthConfig,
	code: string,
	redirectUri: string,
): Promise<OAuthExchangeResult> {
	const params = new URLSearchParams()
	params.set('grant_type', 'authorization_code')
	const clientId = nextConfig.clientId.trim()
	if (!clientId) {
		return { ok: false, status: 0, error: 'Missing client ID.' }
	}
	params.set('client_id', clientId)
	params.set('code', code)
	params.set('redirect_uri', redirectUri)
	if (nextConfig.usePkce) {
		const verifier = sessionStorage.getItem(
			getConnectOauthPkceKey(nextConfig.providerKey),
		)
		if (!verifier) {
			return { ok: false, status: 0, error: 'Missing PKCE verifier.' }
		}
		params.set('code_verifier', verifier)
	}
	const response = await fetch('/account/secrets.json', {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({
			action: 'oauth_exchange',
			tokenUrl: nextConfig.tokenUrl,
			params: params.toString(),
			flow: nextConfig.flow,
			tokenExchangeStyle: nextConfig.tokenExchangeStyle,
			clientSecretSecretName: nextConfig.clientSecretSecretName,
			allowedHosts: nextConfig.allowedHosts,
			...(nextConfig.platformAppSlug
				? { platformAppSlug: nextConfig.platformAppSlug }
				: {}),
		}),
	})
	const text = await response.text()
	let data: Record<string, unknown> | null = null
	try {
		data = JSON.parse(text)
	} catch {
		data = null
	}
	const failure = formatOAuthExchangeFailure({
		status: response.status,
		data,
	})
	if (failure.treatAsSessionExpired) {
		window.location.assign('/login')
		return { ok: false, status: 401, error: 'Session expired.' }
	}
	if (!response.ok || !data) {
		return {
			ok: false,
			status: response.status,
			error: failure.error,
		}
	}
	return { ok: true, data, status: response.status }
}

export async function saveConnectOauthApp(
	nextConfig: ConnectOauthConfig,
): Promise<SaveOauthAppResult> {
	const response = await fetch('/account/secrets.json', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		credentials: 'include',
		body: JSON.stringify({
			action: 'save_oauth_app',
			provider: nextConfig.provider,
			authorizeUrl: nextConfig.authorizeUrl,
			tokenUrl: nextConfig.tokenUrl,
			apiBaseUrl: nextConfig.apiBaseUrl,
			flow: nextConfig.flow,
			usePkce: nextConfig.usePkce,
			tokenExchangeStyle: nextConfig.tokenExchangeStyle,
			clientId: nextConfig.clientId,
			clientSecretSecretName: nextConfig.clientSecretSecretName,
			scopeSeparator: nextConfig.scopeSeparator,
			extraAuthorizeParams: nextConfig.extraAuthorizeParams,
		}),
	})
	if (redirectToLoginOn401(response)) {
		return { ok: false, error: 'Session expired.' }
	}
	const payload = await response.json().catch(() => null)
	if (!response.ok || payload?.ok !== true) {
		return {
			ok: false,
			error: payload?.error || 'Unable to save OAuth app configuration.',
		}
	}
	const savedClientId =
		typeof payload.app?.clientId === 'string' ? payload.app.clientId : null
	if (!savedClientId) {
		return { ok: false, error: 'Unable to save OAuth app configuration.' }
	}
	return { ok: true, clientId: savedClientId }
}

export function normalizeConnectHref(href: string) {
	const url = new URL(href, 'https://kody.local')
	return `${url.pathname}${url.search}`
}

export const connectOauthPageCss = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}

export const connectOauthHeaderCss = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

export const connectOauthEyebrowCss = pageEyebrowCss

export const connectOauthAdvancedDetailsCss = {
	...accountDisclosureCss,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

export const connectOauthRedirectUriCardCss = {
	...cardCss,
	border: `1px solid ${colors.primary}`,
}

export const connectOauthRedirectUriValueCss = {
	...insetCardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-all' as const,
	fontFamily: 'monospace',
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.medium,
}

export const connectOauthPrimaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export const connectOauthSecondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export const connectOauthSuggestionHeaderCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
}

export const connectOauthSuggestionActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
	marginTop: spacing.sm,
}

export const connectOauthTrustedBadgeCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	padding: `0.15rem ${spacing.sm}`,
	borderRadius: radius.md,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
}
