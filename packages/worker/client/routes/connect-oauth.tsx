import {
	normalizeProviderKey,
	safeParseHost,
} from '@kody-internal/shared/url-hosts.ts'
import {
	type AccountIntegrationDetailLoaderData,
	type AccountSecretsLoaderData,
	type ConnectOauthExistingConnection,
	type ConnectOauthLoaderData,
} from '#universal/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import {
	buildHostApprovalRequestUrl,
	submitApprovalRequest,
} from '#client/routes/account-approval-shared.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	detailGridCss,
	detailItemCss,
	detailLabelCss,
	detailValueCss,
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	listCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	primaryLinkCss,
	sectionTitleCss,
	stackedPageCss,
	inputCss,
} from '#universal/styles/style-primitives.ts'
import {
	type ConnectOauthConfig,
	type ConnectOauthHostApprovalLink,
	type ConnectOauthNextSteps,
	type ConnectOauthQueryConfig,
	type OAuthFlow,
	type StoredIntegrationConfig,
	createCodeChallenge,
	createCodeVerifier,
	formatConnectOauthCaughtError,
	formatMissingSetupFields,
	formatOAuthExchangeFailure,
	isSafeExternalUrl,
	mergeConnectOauthConfig,
	normalizeHosts,
	parseAllowedHosts,
	parseConnectOauthNextSteps,
	parseExtraParams,
	parseHostApprovalLinks,
	parseOptionalBoolean,
	parseOptionalUrl,
	parseProviderSetupInstructions,
	parseScopes,
	parseSessionConnectOauthConfig,
	parseTokenExchangeStyle,
	summarizeStoredSetupState,
	toStoredIntegrationConfig,
} from './connect-oauth-config.ts'

type OAuthExchangeResult =
	| { ok: true; data: Record<string, unknown>; status: number }
	| { ok: false; status: number; error: string }

type SaveSecretResult = { ok: true } | { ok: false; error: string }

type SaveOauthAppResult =
	| { ok: true; clientId: string }
	| { ok: false; error: string }

type OAuthCallback =
	| { kind: 'none' }
	| { kind: 'error'; error: string; description: string | null }
	| { kind: 'success'; code: string; state: string | null }

const emptyConnectOauthLoaderData: ConnectOauthLoaderData = {
	ok: true,
	provider: null,
	integration: null,
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
	if (!provider || params.get('code') || params.get('error')) {
		return { connectOauth: emptyConnectOauthLoaderData }
	}
	const providerKey = normalizeProviderKey(provider)
	if (!providerKey) {
		return { connectOauth: emptyConnectOauthLoaderData }
	}
	const platformParam = params.get('platform')?.trim()
	const response = await fetch(
		`/account/integrations.json?name=${encodeURIComponent(providerKey)}${platformParam ? `&platform=${encodeURIComponent(platformParam)}` : ''}`,
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
		},
	}
}

export function ConnectOauthRoute(handle: Handle) {
	type StatusTone = 'info' | 'warn' | 'error'

	// Mirrors the server-side bare-visit redirect for SPA-internal
	// navigations: no provider, no callback code, and no provider error
	// means there is no flow to set up or resume here.
	if (typeof window !== 'undefined') {
		const params = new URLSearchParams(window.location.search)
		if (
			!params.get('provider') &&
			!params.get('code') &&
			!params.get('error')
		) {
			window.location.replace('/guides/oauth')
		}
	}

	// The real status arrives once the query config and any stored/built-in
	// provider config resolve; starting on "Ready to connect." flashed a
	// misleading state on slow connections.
	let statusMessage = 'Loading provider configuration…'
	let statusTone: StatusTone = 'info'
	let currentStep: 'setup' | 'connect' | 'callback' | 'success' = 'setup'
	let config: ConnectOauthConfig | null = null
	let existingIntegrationConfig: StoredIntegrationConfig | null = null
	let accessTokenSaved = false
	let refreshTokenSaved = false
	let hasConfigError = false
	let connectOauthHandled = false
	let hostApprovalLinks: Array<ConnectOauthHostApprovalLink> = []
	/** An enabled built-in exists that this user-lane connection is not using. */
	let builtInAvailable = false
	/** The connection currently stored under the target name, when any. */
	let existingConnection: ConnectOauthExistingConnection | null = null
	/** The user explicitly confirmed replacing a different-app connection. */
	let replaceConfirmed = false
	let renameInput = ''

	/**
	 * True when finishing this flow would overwrite a connection that runs on
	 * a different app or lane — never silently: the user confirms (or renames)
	 * first. Reconnecting the same app under the same name stays free.
	 */
	const wouldReplaceDifferentApp = () => {
		if (!config || !existingConnection) return false
		if (config.platformAppSlug) {
			return (
				existingConnection.lane !== 'platform' ||
				existingConnection.appSlug !== config.platformAppSlug
			)
		}
		return existingConnection.lane === 'platform'
	}
	let nextSteps: ConnectOauthNextSteps | null = null
	let approvingAllHosts = false
	let submitting = false
	let initialLoadStarted = false
	let clientIdInput = ''
	let clientSecretInput = ''
	let hasStoredClientId = false
	let hasStoredClientSecret = false
	let revealStoredClientSecretField = false

	const update = () => handle.update()

	const setStatus = (message: string, tone: StatusTone = 'info') => {
		statusMessage = message
		statusTone = tone
		update()
	}

	const setStep = (step: typeof currentStep) => {
		currentStep = step
		update()
	}

	const setHostApprovalLinks = (
		links: Array<ConnectOauthHostApprovalLink>,
	): void => {
		hostApprovalLinks = links
		update()
	}

	const setNextSteps = (value: ConnectOauthNextSteps | null): void => {
		nextSteps = value
		update()
	}

	const approveAllHostApprovals = async () => {
		if (approvingAllHosts || hostApprovalLinks.length === 0) return
		approvingAllHosts = true
		update()
		const remainingLinks = [...hostApprovalLinks]
		try {
			for (const link of remainingLinks) {
				const requestUrl = buildHostApprovalRequestUrl(
					link.approvalUrl,
					window.location.origin,
				)
				await submitApprovalRequest('approve', requestUrl)
				hostApprovalLinks = hostApprovalLinks.filter(
					(entry) =>
						entry.secretName !== link.secretName || entry.host !== link.host,
				)
				update()
			}
			setStatus('All hosts approved.', 'info')
		} catch (error) {
			setStatus(
				formatConnectOauthCaughtError(error, 'Unable to approve all hosts.'),
				'error',
			)
		} finally {
			approvingAllHosts = false
			update()
		}
	}

	const readQueryConfig = (): ConnectOauthQueryConfig | null => {
		hasConfigError = false
		if (typeof window === 'undefined') return null
		const url = new URL(window.location.href)
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
			hasConfigError = true
			setStatus('Missing required OAuth configuration parameters.', 'error')
			return null
		}
		const authorizeHost = authorizeUrl ? safeParseHost(authorizeUrl) : null
		if (authorizeUrl && (!isSafeExternalUrl(authorizeUrl) || !authorizeHost)) {
			hasConfigError = true
			setStatus('Authorize URL must be valid.', 'error')
			return null
		}
		const tokenHost = tokenUrl ? safeParseHost(tokenUrl) : null
		if (tokenUrl && !tokenHost) {
			hasConfigError = true
			setStatus('Token URL must be valid when provided.', 'error')
			return null
		}
		const rawFlow = readOptional('flow')?.toLowerCase() ?? null
		const flow: OAuthFlow | null =
			rawFlow === 'pkce' || rawFlow === 'confidential' ? rawFlow : null
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
		const providerKey = normalizeProviderKey(provider)
		if (!providerKey) {
			hasConfigError = true
			setStatus('Provider must contain letters or numbers.', 'error')
			return null
		}
		const providerSetupInstructions = parseProviderSetupInstructions(
			readOptional('providerSetupInstructions'),
		)
		const allowedHosts = normalizeHosts([
			...(tokenHost ? [tokenHost] : []),
			...parseAllowedHosts(readOptional('allowedHosts')),
		])
		return {
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
		}
	}

	const readCallback = (): OAuthCallback => {
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

	const getRedirectUri = (): string => {
		if (typeof window === 'undefined') return ''
		return `${window.location.origin}${window.location.pathname}`
	}

	const getStateKey = (providerKey: string) => `connect-oauth:${providerKey}`

	const getPkceKey = (providerKey: string) =>
		`connect-oauth:${providerKey}:pkce`

	const configStorageKey = 'connect-oauth:config'

	const persistConfig = (nextConfig: ConnectOauthConfig) => {
		try {
			sessionStorage.setItem(configStorageKey, JSON.stringify(nextConfig))
		} catch {
			// Config caching is best-effort; the required OAuth state write below still fails visibly.
		}
	}

	const readStoredConfig = (): ConnectOauthConfig | null => {
		if (typeof window === 'undefined') return null
		const raw = sessionStorage.getItem(configStorageKey)
		if (!raw) return null
		return parseSessionConnectOauthConfig(raw)
	}

	const createState = (key: string) => {
		const value = crypto.randomUUID()
		sessionStorage.setItem(key, value)
		return value
	}

	const validateState = (key: string, returned: string | null) => {
		const expected = sessionStorage.getItem(key)
		return Boolean(expected && returned && expected === returned)
	}

	const reservedAuthorizeParams = new Set([
		'client_id',
		'code_challenge',
		'code_challenge_method',
		'redirect_uri',
		'response_type',
		'scope',
		'state',
	])

	const buildAuthorizeUrl = async (nextConfig: ConnectOauthConfig) => {
		if (hasConfigError) {
			throw new Error('Unable to start OAuth with invalid configuration.')
		}
		persistConfig(nextConfig)
		const url = new URL(nextConfig.authorizeUrl)
		url.searchParams.set('response_type', 'code')
		const clientId = nextConfig.clientId.trim()
		if (!clientId) {
			throw new Error('Missing client ID. Save it before connecting.')
		}
		url.searchParams.set('client_id', clientId)
		url.searchParams.set('redirect_uri', getRedirectUri())
		if (nextConfig.scopes.length > 0) {
			url.searchParams.set(
				'scope',
				nextConfig.scopes.join(nextConfig.scopeSeparator),
			)
		}
		const state = createState(getStateKey(nextConfig.providerKey))
		url.searchParams.set('state', state)
		if (nextConfig.usePkce) {
			const verifier = createCodeVerifier()
			sessionStorage.setItem(getPkceKey(nextConfig.providerKey), verifier)
			const challenge = await createCodeChallenge(verifier)
			url.searchParams.set('code_challenge_method', 'S256')
			url.searchParams.set('code_challenge', challenge)
		}
		for (const [key, value] of Object.entries(
			nextConfig.extraAuthorizeParams,
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
	const redirectToLoginOn401 = (response: Response) => {
		if (response.status !== 401) return false
		window.location.assign('/login')
		return true
	}

	const listSecrets = async () => {
		const response = await fetch('/account/secrets.json', {
			method: 'GET',
			headers: {
				Accept: 'application/json',
			},
			credentials: 'include',
		})
		if (redirectToLoginOn401(response)) return null
		const payload = (await response.json().catch(() => null)) as Pick<
			AccountSecretsLoaderData,
			'ok' | 'secrets'
		> | null
		if (
			!response.ok ||
			payload?.ok !== true ||
			!Array.isArray(payload.secrets)
		) {
			return null
		}
		return payload.secrets
	}

	const readExistingIntegrationConfig = async (
		queryConfig: ConnectOauthQueryConfig,
	): Promise<StoredIntegrationConfig | null> => {
		const platformParam =
			typeof window !== 'undefined'
				? (new URLSearchParams(window.location.search)
						.get('platform')
						?.trim() ?? '')
				: ''
		const response = await fetch(
			`/account/integrations.json?name=${encodeURIComponent(queryConfig.providerKey)}${platformParam ? `&platform=${encodeURIComponent(platformParam)}` : ''}`,
			{
				method: 'GET',
				headers: { Accept: 'application/json' },
				credentials: 'include',
			},
		)
		if (redirectToLoginOn401(response)) return null
		const payload = (await response
			.json()
			.catch(() => null)) as AccountIntegrationDetailLoaderData | null
		if (!response.ok || payload?.ok !== true) return null
		builtInAvailable = payload.builtInAvailable ?? false
		existingConnection = payload.existingConnection ?? null
		if (!payload.integration) return null
		return toStoredIntegrationConfig(payload.integration)
	}

	const initializeSetupState = async (nextConfig: ConnectOauthConfig) => {
		const secrets = nextConfig.clientSecretSecretName
			? await listSecrets()
			: null
		clientIdInput = nextConfig.clientId
		clientSecretInput = ''
		hasStoredClientId = Boolean(nextConfig.clientId.trim())
		hasStoredClientSecret = Boolean(
			nextConfig.clientSecretSecretName &&
			secrets?.some(
				(secret) =>
					secret.scope === 'user' &&
					secret.name === nextConfig.clientSecretSecretName,
			),
		)
		revealStoredClientSecretField = false
		const setupStatus = summarizeStoredSetupState({
			flow: nextConfig.flow,
			clientId: nextConfig.clientId,
			hasStoredClientSecret,
			platform: Boolean(nextConfig.platformAppSlug),
		})
		if (setupStatus.isReady) {
			setStatus(
				nextConfig.platformAppSlug
					? 'Built-in integration — no OAuth app setup needed. Ready to connect.'
					: existingIntegrationConfig
						? 'Loaded your existing integration config and client credentials. Ready to connect.'
						: 'Loaded your existing OAuth client configuration. Ready to connect.',
			)
			setStep('connect')
			return
		}
		const missingDetails = formatMissingSetupFields(setupStatus.missingFields)
		setStatus(
			existingIntegrationConfig
				? `Loaded your existing integration config. ${missingDetails}`
				: missingDetails,
		)
		setStep('setup')
	}

	const saveSecret = async (
		name: string,
		value: string,
		description: string,
		allowedHosts: Array<string>,
	): Promise<SaveSecretResult> => {
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
				allowedCapabilities: [],
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

	const exchangeOAuthCode = async (
		nextConfig: ConnectOauthConfig,
		code: string,
	): Promise<OAuthExchangeResult> => {
		const params = new URLSearchParams()
		params.set('grant_type', 'authorization_code')
		const clientId = nextConfig.clientId.trim()
		if (!clientId) {
			return { ok: false, status: 0, error: 'Missing client ID.' }
		}
		params.set('client_id', clientId)
		params.set('code', code)
		params.set('redirect_uri', getRedirectUri())
		if (nextConfig.usePkce) {
			const verifier = sessionStorage.getItem(
				getPkceKey(nextConfig.providerKey),
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

	const saveOauthApp = async (
		nextConfig: ConnectOauthConfig,
	): Promise<SaveOauthAppResult> => {
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

	const handleSetupSubmit = async (event: Event) => {
		event.preventDefault()
		if (!config || submitting) return
		submitting = true
		update()
		try {
			const clientId = clientIdInput.trim()
			const clientSecret = clientSecretInput.trim()
			if (!clientId) {
				setStatus('Client ID is required.', 'error')
				return
			}
			if (
				config.flow === 'confidential' &&
				(!hasStoredClientSecret || revealStoredClientSecretField)
			) {
				if (!clientSecret) {
					setStatus('Client secret is required for confidential flow.', 'error')
					return
				}
				const secretResult = await saveSecret(
					config.clientSecretSecretName ?? '',
					clientSecret,
					`${config.provider} OAuth client secret`,
					config.allowedHosts,
				)
				if (!secretResult.ok) {
					setStatus(secretResult.error, 'error')
					return
				}
				hasStoredClientSecret = true
				revealStoredClientSecretField = false
				clientSecretInput = ''
			}
			const nextConfig = { ...config, clientId }
			const appResult = await saveOauthApp(nextConfig)
			if (!appResult.ok) {
				setStatus(appResult.error, 'error')
				return
			}
			config = { ...nextConfig, clientId: appResult.clientId }
			persistConfig(config)
			hasStoredClientId = true
			setStatus('Saved OAuth client configuration.', 'info')
			setStep('connect')
		} catch (error) {
			// fetch() TypeError (Firefox NetworkError / Chromium Failed to fetch)
			// must not escape as unhandledrejection — KODY-CLOUDFLARE-3P.
			setStatus(
				formatConnectOauthCaughtError(
					error,
					'Network error. Please try again.',
				),
				'error',
			)
		} finally {
			submitting = false
			update()
		}
	}

	/**
	 * Interposed before a flow that would overwrite a connection running on
	 * a different app or lane: the user explicitly replaces, or connects the
	 * built-in under a new name so the existing connection stays intact.
	 */
	const renderReplaceConfirmation = () => {
		if (!config || !wouldReplaceDifferentApp() || replaceConfirmed) {
			return null
		}
		const existingLabel =
			existingConnection?.lane === 'platform'
				? `the built-in ${existingConnection.appSlug} integration`
				: 'your own OAuth app'
		const renameSuggestion = `${config.providerKey}-2`
		return (
			<div mix={css(insetCardCss)}>
				<p mix={css({ margin: 0, color: colors.text, fontWeight: 600 })}>
					You already have a {config.providerKey} connection using{' '}
					{existingLabel}.
				</p>
				<p mix={css(descriptionCss)}>
					Continuing replaces its tokens and scopes. You can also keep it and
					connect under a different name.
				</p>
				<div
					mix={css({
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					})}
				>
					<button
						type="button"
						disabled={submitting}
						mix={[
							on('click', () => {
								replaceConfirmed = true
								update()
								void handleConnect()
							}),
							css(getSecondaryButtonCss()),
						]}
						data-testid="connect-replace-confirm"
					>
						Replace {config.providerKey}
					</button>
					{config.platformAppSlug ? (
						<>
							<span mix={css(descriptionCss)}>or connect as</span>
							<input
								type="text"
								placeholder={renameSuggestion}
								value={renameInput}
								{...passwordManagerIgnoreProps}
								mix={[
									on('input', (event) => {
										renameInput = event.currentTarget.value
										update()
									}),
									css({ ...inputCss, maxWidth: '12rem' }),
								]}
								data-testid="connect-rename-input"
							/>
							<button
								type="button"
								disabled={submitting}
								mix={[
									on('click', () => {
										const name = renameInput.trim() || renameSuggestion
										// Full document load: the connect flow
										// initializes per document load.
										window.location.assign(
											`/connect/oauth?provider=${encodeURIComponent(name)}&platform=${encodeURIComponent(config!.platformAppSlug!)}`,
										)
									}),
									css(getPrimaryButtonCss()),
								]}
								data-testid="connect-rename-submit"
							>
								Connect
							</button>
						</>
					) : null}
				</div>
			</div>
		)
	}

	/**
	 * Shown when the current (or prospective) connection runs on the user's
	 * own OAuth app while an enabled built-in exists for the same name. A
	 * complete bring-your-own record wins the lookup by design, so without
	 * this the built-in lane is invisible from the connect page.
	 */
	const renderBuiltInAlternative = () => {
		if (!builtInAvailable || !config || config.platformAppSlug) return null
		return (
			<p mix={css(descriptionCss)}>
				This uses your own OAuth app for {config.provider}. Prefer the hosted
				one?{' '}
				<a
					href={`/connect/oauth?provider=${encodeURIComponent(config.providerKey)}&platform=1`}
					mix={[
						css(primaryLinkCss),
						// Full document load on purpose: this page's init
						// (config resolution, built-in auto-start) runs per
						// document load, and a same-route SPA swap reuses the
						// mounted instance without re-running it.
						on('click', (event) => {
							event.preventDefault()
							window.location.assign(event.currentTarget.href)
						}),
					]}
				>
					Use the built-in {config.provider} integration instead
				</a>{' '}
				— connecting it replaces this connection&apos;s tokens and scopes.
			</p>
		)
	}

	const handleConnect = async () => {
		if (!config || submitting) return
		submitting = true
		update()
		try {
			const url = await buildAuthorizeUrl(config)
			window.location.assign(url)
		} catch (error) {
			setStatus(
				formatConnectOauthCaughtError(error, 'Unable to start OAuth.'),
				'error',
			)
		} finally {
			submitting = false
			update()
		}
	}

	const handleCallback = async () => {
		if (!config) return
		setStep('callback')
		try {
			const callback = readCallback()
			if (callback.kind !== 'none') {
				window.history.replaceState(null, '', getRedirectUri())
			}
			if (callback.kind === 'error') {
				setStatus(
					callback.description || `OAuth error: ${callback.error}`,
					'error',
				)
				setStep('connect')
				return
			}
			if (callback.kind !== 'success') return
			const valid = validateState(
				getStateKey(config.providerKey),
				callback.state,
			)
			if (!valid) {
				setStatus('State mismatch. Restart the OAuth flow.', 'error')
				setStep('connect')
				return
			}
			const exchange = await exchangeOAuthCode(config, callback.code)
			if (!exchange.ok) {
				setStatus(exchange.error, 'error')
				setStep(
					exchange.error.includes('client ID') ||
						exchange.error.includes('client secret')
						? 'setup'
						: 'connect',
				)
				return
			}
			const callbackUrl = window.location.href
			const response = await fetch('/account/secrets.json', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					action: 'connect_oauth',
					provider: config.provider,
					callbackUrl,
					...(config.platformAppSlug
						? { platformAppSlug: config.platformAppSlug }
						: {}),
					authorizeUrl: config.authorizeUrl,
					tokenUrl: config.tokenUrl,
					apiBaseUrl: config.apiBaseUrl,
					scopes: config.scopes,
					scopeSeparator: config.scopeSeparator,
					extraAuthorizeParams: config.extraAuthorizeParams,
					flow: config.flow,
					usePkce: config.usePkce,
					tokenExchangeStyle: config.tokenExchangeStyle,
					clientId: config.clientId,
					clientSecretSecretName: config.clientSecretSecretName,
					allowedHosts: config.allowedHosts,
					accessTokenSecretName: config.accessTokenSecretName,
					refreshTokenSecretName: config.refreshTokenSecretName,
					tokenPayload: exchange.data,
				}),
			})
			if (redirectToLoginOn401(response)) return
			const payload = await response.json().catch(() => null)
			if (!response.ok || payload?.ok !== true) {
				setStatus(payload?.error || 'Unable to save OAuth tokens.', 'error')
				setStep('connect')
				return
			}
			accessTokenSaved = payload.accessTokenSaved === true
			refreshTokenSaved = payload.refreshTokenSaved === true
			setHostApprovalLinks(parseHostApprovalLinks(payload.hostApprovalLinks))
			setNextSteps(parseConnectOauthNextSteps(payload.nextSteps))
			setStatus('OAuth tokens saved.', 'info')
			setStep('success')
		} catch (error) {
			// Same class as setup submit: token exchange / save fetch failures
			// must surface in-page, not as unhandledrejection (KODY-CLOUDFLARE-3P).
			setStatus(
				formatConnectOauthCaughtError(
					error,
					'Network error. Please try again.',
				),
				'error',
			)
			setStep('connect')
		}
	}

	const renderRedirectUriCard = () => {
		// Built-in apps are registered by the operator; users have nothing to
		// paste into a provider console.
		if (config?.platformAppSlug) return null
		const redirectUri = getRedirectUri()
		if (!redirectUri) return null
		return (
			<section mix={css(redirectUriCardCss)}>
				<h2 mix={css(cardTitleCss)}>Redirect URI</h2>
				<p mix={css({ margin: 0, color: colors.text })}>
					Register this exact URL as the redirect (callback) URI in your
					provider&apos;s OAuth app settings.
				</p>
				<pre mix={css(redirectUriValueCss)}>{redirectUri}</pre>
				<div>
					<CopyTextButton
						value={redirectUri}
						idleLabel="Copy redirect URI"
						variant="primary"
					/>
				</div>
			</section>
		)
	}

	const renderProviderInstructions = () => {
		if (!config) return null
		const instructions = config.providerSetupInstructions
		return (
			<>
				<ol mix={css(listCss)}>
					<li>
						Create an OAuth app in your provider&apos;s developer console.
					</li>
					<li>Register the exact redirect URI shown above.</li>
					<li>Enable any APIs and scopes the integration needs.</li>
					<li>
						Paste the client ID
						{config.flow === 'confidential' && !hasStoredClientSecret
							? ' and client secret'
							: ''}{' '}
						below.
					</li>
				</ol>
				{instructions && instructions.trim() ? (
					<p mix={css({ ...insetCardCss, margin: 0, whiteSpace: 'pre-wrap' })}>
						{instructions}
					</p>
				) : null}
			</>
		)
	}

	const renderAllowedHosts = () => {
		if (!config) return null
		return (
			<section mix={css(insetCardCss)}>
				<h3 mix={css(sectionTitleCss)}>Allowed hosts</h3>
				<p mix={css(descriptionCss)}>
					These hosts will be approved for the saved secrets. Host approvals are
					never automatic.
				</p>
				<ul mix={css(listCss)}>
					{config.allowedHosts.map((host) => (
						<li key={host}>{host}</li>
					))}
				</ul>
			</section>
		)
	}

	const renderExistingIntegrationConfig = () => {
		if (!existingIntegrationConfig) return null
		return (
			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Existing integration config</h2>
				<p mix={css(descriptionCss)}>
					Loaded your saved connection{' '}
					<code>{existingIntegrationConfig.name}</code>.
				</p>
				<div mix={css(detailGridCss)}>
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>Flow</span>
						<span mix={css(detailValueCss)}>
							{existingIntegrationConfig.flow}
						</span>
					</div>
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>Token URL</span>
						<code mix={css(detailValueCss)}>
							{existingIntegrationConfig.tokenUrl}
						</code>
					</div>
					{existingIntegrationConfig.apiBaseUrl ? (
						<div mix={css(detailItemCss)}>
							<span mix={css(detailLabelCss)}>API base URL</span>
							<code mix={css(detailValueCss)}>
								{existingIntegrationConfig.apiBaseUrl}
							</code>
						</div>
					) : null}
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>Client ID</span>
						<code mix={css(detailValueCss)}>
							{existingIntegrationConfig.clientId}
						</code>
					</div>
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>Client secret secret</span>
						<code mix={css(detailValueCss)}>
							{existingIntegrationConfig.clientSecretSecretName ?? 'Not used'}
						</code>
					</div>
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>Access token secret</span>
						<code mix={css(detailValueCss)}>
							{existingIntegrationConfig.accessTokenSecretName}
						</code>
					</div>
					<div mix={css(detailItemCss)}>
						<span mix={css(detailLabelCss)}>Refresh token secret</span>
						<code mix={css(detailValueCss)}>
							{existingIntegrationConfig.refreshTokenSecretName ?? 'Not used'}
						</code>
					</div>
				</div>
				{existingIntegrationConfig.authorization ? (
					<div mix={css(insetCardCss)}>
						<strong mix={css(sectionTitleCss)}>Authorization metadata</strong>
						<div mix={css(detailGridCss)}>
							<div mix={css(detailItemCss)}>
								<span mix={css(detailLabelCss)}>Authorize URL</span>
								<code mix={css(detailValueCss)}>
									{existingIntegrationConfig.authorization.authorizeUrl}
								</code>
							</div>
							<div mix={css(detailItemCss)}>
								<span mix={css(detailLabelCss)}>Scopes</span>
								<span mix={css(detailValueCss)}>
									{existingIntegrationConfig.authorization.scopes.length
										? existingIntegrationConfig.authorization.scopes.join(' ')
										: 'None'}
								</span>
							</div>
						</div>
					</div>
				) : null}
				<div mix={css(insetCardCss)}>
					<strong mix={css(sectionTitleCss)}>Required hosts</strong>
					{existingIntegrationConfig.requiredHosts.length > 0 ? (
						<ul mix={css(listCss)}>
							{existingIntegrationConfig.requiredHosts.map((host) => (
								<li key={host}>{host}</li>
							))}
						</ul>
					) : (
						<p mix={css(descriptionCss)}>None configured.</p>
					)}
				</div>
			</section>
		)
	}

	handle.queueTask(async () => {
		if (initialLoadStarted) return
		initialLoadStarted = true
		try {
			// SSR-embedded on direct visits, loader-prefetched on SPA
			// navigations; the integrations fetch below only runs as a
			// fallback (e.g. callback returns that lost sessionStorage).
			const routeData = tryConsumeRouteLoaderData(
				handle,
				'connectOauth',
				readCurrentRouterHref(handle),
			)
			if (routeData) {
				builtInAvailable = routeData.builtInAvailable ?? false
				existingConnection = routeData.existingConnection ?? null
			}
			const preloadedIntegrationFor = (providerKey: string) =>
				routeData && routeData.provider === providerKey
					? routeData.integration
					: undefined
			const resolveExistingIntegration = async (
				queryConfig: ConnectOauthQueryConfig,
			): Promise<StoredIntegrationConfig | null> => {
				const preloaded = preloadedIntegrationFor(queryConfig.providerKey)
				if (preloaded !== undefined) {
					return preloaded ? toStoredIntegrationConfig(preloaded) : null
				}
				return readExistingIntegrationConfig(queryConfig)
			}
			const callback = readCallback()
			if (callback.kind === 'success' || callback.kind === 'error') {
				const storedConfig = readStoredConfig()
				const queryConfig = storedConfig ? null : readQueryConfig()
				const nextConfig =
					storedConfig ??
					(queryConfig
						? mergeConnectOauthConfig({
								queryConfig,
								storedIntegration:
									await resolveExistingIntegration(queryConfig),
							})
						: null)
				if (!nextConfig) {
					setStatus('Missing required OAuth configuration parameters.', 'error')
					return
				}
				config = nextConfig
				if (!connectOauthHandled) {
					connectOauthHandled = true
					await handleCallback()
				}
				return
			}
			const queryConfig = readQueryConfig()
			if (!queryConfig) {
				setStatus('Missing required OAuth configuration parameters.', 'error')
				return
			}
			const existingIntegration = await resolveExistingIntegration(queryConfig)
			existingIntegrationConfig = existingIntegration
			const nextConfig = mergeConnectOauthConfig({
				queryConfig,
				storedIntegration: existingIntegration,
			})
			if (!nextConfig) {
				hasConfigError = true
				setStatus('Missing required OAuth configuration parameters.', 'error')
				return
			}
			config = nextConfig
			await initializeSetupState(nextConfig)
			// Built-in integrations have nothing for the user to review or
			// fill in, so a plain ?provider=<slug> visit (the onboarding
			// cards, docs links) goes straight into the provider's authorize
			// flow. Callback returns never reach this branch — code and
			// error visits take the callback path — so a denial cannot
			// loop back into an auto-start. A flow that would replace a
			// different-app connection never auto-starts: the user confirms
			// or renames first.
			if (
				nextConfig.platformAppSlug &&
				currentStep === 'connect' &&
				!wouldReplaceDifferentApp()
			) {
				setStatus(`Redirecting to ${nextConfig.provider} to authorize…`)
				await handleConnect()
			}
		} catch (error) {
			// Initial integration/secrets reads use fetch(); a transient network
			// failure must not escape queueTask as unhandledrejection.
			setStatus(
				formatConnectOauthCaughtError(
					error,
					'Network error. Please try again.',
				),
				'error',
			)
		}
	})

	return () => {
		if (!config) {
			return (
				<section mix={css(pageCss)}>
					<header mix={css(headerCss)}>
						<span mix={css(eyebrowCss)}>Kody secure connection</span>
						<h1 mix={css(pageTitleCss)}>Connect OAuth</h1>
						<p mix={css(pageDescriptionCss)}>{statusMessage}</p>
					</header>
					{renderRedirectUriCard()}
				</section>
			)
		}
		return (
			<section mix={css(pageCss)}>
				<header mix={css(headerCss)}>
					<span mix={css(eyebrowCss)}>Kody secure connection</span>
					<h1
						mix={css({
							...pageTitleCss,
							display: 'flex',
							alignItems: 'center',
							gap: spacing.sm,
						})}
					>
						{config.platformLogoPath ? (
							<img
								src={config.platformLogoPath}
								alt=""
								width={36}
								height={36}
								mix={css({ borderRadius: radius.sm })}
							/>
						) : null}
						Connect {config.provider}
					</h1>
					{config.platformDescription ? (
						<p mix={css(pageDescriptionCss)}>{config.platformDescription}</p>
					) : (
						<p mix={css(pageDescriptionCss)}>
							Follow the steps below to connect your account using OAuth.
						</p>
					)}
				</header>
				<section mix={css(getStatusCardCss(statusTone))}>
					<div
						mix={css({
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
							gap: spacing.sm,
							flexWrap: 'wrap',
						})}
					>
						<strong mix={css(sectionTitleCss)}>Status</strong>
						<span mix={css(getStatusBadgeCss(statusTone))}>{currentStep}</span>
					</div>
					<p mix={css(getStatusMessageCss(statusTone))}>{statusMessage}</p>
				</section>
				{renderRedirectUriCard()}
				<section mix={css(cardCss)}>
					<h2 mix={css(cardTitleCss)}>Provider details</h2>
					<div mix={css(detailGridCss)}>
						<div mix={css(detailItemCss)}>
							<span mix={css(detailLabelCss)}>Authorize URL</span>
							<code mix={css(detailValueCss)}>{config.authorizeUrl}</code>
						</div>
						<div mix={css(detailItemCss)}>
							<span mix={css(detailLabelCss)}>Token URL</span>
							<code mix={css(detailValueCss)}>{config.tokenUrl}</code>
						</div>
						<div mix={css(detailItemCss)}>
							<span mix={css(detailLabelCss)}>Flow</span>
							<span mix={css(detailValueCss)}>{config.flow}</span>
						</div>
						<div mix={css(detailItemCss)}>
							<span mix={css(detailLabelCss)}>PKCE</span>
							<span mix={css(detailValueCss)}>
								{config.usePkce ? 'S256' : 'off'}
							</span>
						</div>
						<div mix={css(detailItemCss)}>
							<span mix={css(detailLabelCss)}>Scopes</span>
							<span mix={css(detailValueCss)}>
								{config.scopes.length ? config.scopes.join(' ') : 'None'}
							</span>
						</div>
					</div>
					{config.dashboardUrl && isSafeExternalUrl(config.dashboardUrl) ? (
						<a
							href={config.dashboardUrl}
							target="_blank"
							rel="noreferrer noopener"
							mix={css(primaryLinkCss)}
						>
							Open provider dashboard
						</a>
					) : null}
				</section>
				{renderExistingIntegrationConfig()}
				{currentStep === 'setup' ? (
					<section mix={css(cardCss)}>
						<h2 mix={css(cardTitleCss)}>
							1. {existingIntegrationConfig ? 'Review' : 'Save'} OAuth client
							configuration
						</h2>
						{renderBuiltInAlternative()}
						{renderProviderInstructions()}
						{renderAllowedHosts()}
						<form
							{...passwordManagerIgnoreProps}
							mix={[
								on('submit', handleSetupSubmit),
								css({ display: 'grid', gap: spacing.md }),
							]}
						>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Client ID</span>
								<input
									name="oauthClientId"
									required
									{...passwordManagerIgnoreProps}
									value={clientIdInput}
									mix={[
										on(
											'input',

											(event) => {
												clientIdInput = event.currentTarget.value
												update()
											},
										),

										css(inputCss),
									]}
								/>
							</label>
							<p mix={css(descriptionCss)}>
								{hasStoredClientId
									? 'Stored on the OAuth app for this connection.'
									: 'Saved on the OAuth app when you finish connecting.'}
							</p>
							{config.flow === 'confidential' ? (
								hasStoredClientSecret && !revealStoredClientSecretField ? (
									<section mix={css(insetCardCss)}>
										<p mix={css({ margin: 0, color: colors.text })}>
											Using the stored client secret in{' '}
											<code>
												{config.clientSecretSecretName ?? 'unknown secret'}
											</code>
											.
										</p>
										<p mix={css(descriptionCss)}>
											You can continue without re-entering it.
										</p>
										<button
											type="button"
											mix={[
												css(secondaryButtonCss),
												on(
													'click',

													() => {
														revealStoredClientSecretField = true
														update()
													},
												),
											]}
										>
											Replace stored client secret
										</button>
									</section>
								) : (
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Client Secret</span>
										<input
											name="oauthClientSecret"
											type="password"
											required
											{...passwordManagerIgnoreProps}
											value={clientSecretInput}
											mix={[
												on(
													'input',

													(event) => {
														clientSecretInput = event.currentTarget.value
														update()
													},
												),

												css(inputCss),
											]}
										/>
									</label>
								)
							) : null}
							<button
								type="submit"
								disabled={submitting}
								mix={css(primaryButtonCss)}
							>
								Save configuration
							</button>
						</form>
					</section>
				) : null}
				{currentStep === 'connect' ? (
					<section mix={css(cardCss)}>
						<h2 mix={css(cardTitleCss)}>2. Connect</h2>
						<p mix={css({ margin: 0, color: colors.text })}>
							Start the OAuth flow. You will be redirected to the provider.
						</p>
						{renderReplaceConfirmation()}
						{renderBuiltInAlternative()}
						{existingIntegrationConfig && hasStoredClientId ? (
							<p mix={css(descriptionCss)}>
								Using stored client ID
								{config.flow === 'confidential' && hasStoredClientSecret
									? ` and stored client secret ${config.clientSecretSecretName ?? ''}.`
									: '.'}
							</p>
						) : null}
						<p mix={css(descriptionCss)}>
							Connecting authorizes your agent — and any code you run or install
							— to act as you on {config.provider} with the scopes you grant.
							Kody does not control or supervise what your agent does with this
							access; that responsibility is yours. See the{' '}
							<a href="/terms" target="_blank" rel="noreferrer noopener">
								Terms
							</a>
							.
						</p>
						{/* The primary button yields to the replace confirmation so a
						    different-app overwrite is never one ambient click away. */}
						{wouldReplaceDifferentApp() && !replaceConfirmed ? null : (
							<button
								type="button"
								disabled={submitting}
								mix={[
									on('click', () => void handleConnect()),
									css(primaryButtonCss),
								]}
							>
								Connect {config.provider}
							</button>
						)}
					</section>
				) : null}
				{currentStep === 'success' ? (
					<section mix={css(cardCss)}>
						<h2 mix={css(cardTitleCss)}>4. Success</h2>
						<div mix={css(detailGridCss)}>
							<div mix={css(detailItemCss)}>
								<span mix={css(detailLabelCss)}>Access token saved</span>
								<strong mix={css(detailValueCss)}>
									{accessTokenSaved ? 'Yes' : 'No'}
								</strong>
							</div>
							<div mix={css(detailItemCss)}>
								<span mix={css(detailLabelCss)}>Refresh token saved</span>
								<strong mix={css(detailValueCss)}>
									{refreshTokenSaved ? 'Yes' : 'No'}
								</strong>
							</div>
						</div>
						{nextSteps ? (
							<div mix={css(insetCardCss)}>
								<h3 mix={css(sectionTitleCss)}>Next: helpers package</h3>
								<p mix={css(descriptionCss)}>{nextSteps.guidance}</p>
								{nextSteps.suggestions.length > 0 ? (
									<ul mix={css(listCss)}>
										{nextSteps.suggestions.map((suggestion) => (
											<li key={suggestion.listingId}>
												<div mix={css(suggestionHeaderCss)}>
													<a
														href={suggestion.publicUrl}
														target="_blank"
														rel="noreferrer noopener"
														mix={css(primaryLinkCss)}
													>
														{suggestion.name}
													</a>
													{suggestion.trusted ? (
														<span mix={css(trustedBadgeCss)}>Trusted</span>
													) : null}
												</div>
												<p mix={css(descriptionCss)}>
													{suggestion.description}
												</p>
												<div mix={css(suggestionActionsCss)}>
													<a
														href={suggestion.publicUrl}
														target="_blank"
														rel="noreferrer noopener"
														mix={css(primaryLinkCss)}
													>
														View listing
													</a>
													<CopyTextButton
														value={suggestion.forkPrompt}
														idleLabel="Copy fork prompt"
														variant="secondary"
													/>
												</div>
											</li>
										))}
									</ul>
								) : null}
								<div mix={css(suggestionActionsCss)}>
									<strong mix={css(detailValueCss)}>
										{nextSteps.createHelpersCta.label}
									</strong>
									<CopyTextButton
										value={nextSteps.createHelpersCta.prompt}
										idleLabel="Copy create prompt"
										variant="secondary"
									/>
								</div>
							</div>
						) : null}
						<h3 mix={css(sectionTitleCss)}>Host approvals</h3>
						<p mix={css({ margin: 0, color: colors.text })}>
							Hosts are never auto-approved. Review these allowed hosts in your
							account secrets.
						</p>
						<ul mix={css(listCss)}>
							{config.allowedHosts.map((host) => (
								<li key={host}>{host}</li>
							))}
						</ul>
						{hostApprovalLinks.length > 0 ? (
							<div mix={css(insetCardCss)}>
								<p mix={css(descriptionCss)}>
									Approve each token host directly:
								</p>
								<button
									type="button"
									disabled={approvingAllHosts}
									mix={[
										on('click', () => void approveAllHostApprovals()),
										css(primaryButtonCss),
									]}
								>
									{approvingAllHosts ? 'Approving hosts…' : 'Approve all hosts'}
								</button>
								<ul mix={css(listCss)}>
									{hostApprovalLinks.map((link) => (
										<li key={`${link.secretName}:${link.host}`}>
											<a
												href={link.approvalUrl}
												target="_blank"
												rel="noreferrer noopener"
												mix={css(primaryLinkCss)}
											>
												Approve <code>{link.host}</code> for{' '}
												<code>{link.secretName}</code>
											</a>
										</li>
									))}
								</ul>
							</div>
						) : null}
						<a
							href="/account/secrets"
							target="_blank"
							rel="noreferrer"
							mix={css(primaryLinkCss)}
						>
							Open account secrets
						</a>
					</section>
				) : null}
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '56rem',
	margin: '0 auto',
}

const headerCss = pageHeaderCss
const eyebrowCss = pageEyebrowCss

const redirectUriCardCss = {
	...cardCss,
	border: `1px solid ${colors.primary}`,
}

const redirectUriValueCss = {
	...insetCardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-all' as const,
	fontFamily: 'monospace',
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.medium,
}
const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const suggestionHeaderCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
}
const suggestionActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
	marginTop: spacing.sm,
}
const trustedBadgeCss = {
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

function getStatusCardCss(tone: 'info' | 'warn' | 'error') {
	return {
		...cardCss,
		border: `1px solid ${tone === 'error' ? colors.error : colors.primary}`,
		backgroundColor:
			tone === 'error'
				? 'color-mix(in srgb, var(--color-danger) 8%, var(--color-surface))'
				: colors.primarySoftest,
	}
}

function getStatusBadgeCss(tone: 'info' | 'warn' | 'error') {
	return {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: `0.25rem ${spacing.sm}`,
		borderRadius: radius.full,
		backgroundColor:
			tone === 'error'
				? 'color-mix(in srgb, var(--color-danger) 14%, transparent)'
				: colors.surface,
		color: tone === 'error' ? colors.error : colors.primaryText,
		fontSize: typography.fontSize.xs,
		fontWeight: typography.fontWeight.semibold,
		letterSpacing: '0.08em',
		textTransform: 'uppercase' as const,
	}
}

function getStatusMessageCss(tone: 'info' | 'warn' | 'error') {
	return {
		margin: 0,
		color: tone === 'error' ? colors.error : colors.text,
	}
}
