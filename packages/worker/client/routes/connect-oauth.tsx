import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import {
	normalizeProviderKey,
	safeParseHost,
} from '@kody-internal/shared/url-hosts.ts'
import {
	type AccountIntegrationDetailLoaderData,
	type AccountIntegrationListItem,
	type AccountSecretsLoaderData,
} from '#app/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import {
	buildHostApprovalRequestUrl,
	submitApprovalRequest,
} from '#client/routes/account-approval-shared.ts'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
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
} from '#client/styles/style-primitives.ts'

type OAuthFlow = 'pkce' | 'confidential'
type TokenExchangeStyle = 'form' | 'basic-json' | 'basic-form'

type ConnectOauthQueryConfig = {
	provider: string
	providerKey: string
	authorizeHost: string | null
	authorizeUrl: string | null
	tokenUrl: string | null
	apiBaseUrl: string | null
	scopes: Array<string> | null
	flow: OAuthFlow | null
	usePkce: boolean | null
	tokenExchangeStyle: TokenExchangeStyle | null
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string> | null
	providerSetupInstructions: string | null
	dashboardUrl: string | null
	allowedHosts: Array<string>
}

type ConnectOauthConfig = {
	provider: string
	providerKey: string
	authorizeHost: string
	tokenHost: string
	authorizeUrl: string
	tokenUrl: string
	apiBaseUrl: string | null
	scopes: Array<string>
	flow: OAuthFlow
	/**
	 * PKCE is orthogonal to `flow`: providers like Canva require S256 PKCE
	 * *and* a client secret on token exchange.
	 */
	usePkce: boolean
	tokenExchangeStyle: TokenExchangeStyle
	scopeSeparator: string
	extraAuthorizeParams: Record<string, string>
	providerSetupInstructions: string | null
	dashboardUrl: string | null
	clientId: string
	clientSecretSecretName: string | null
	accessTokenSecretName: string
	refreshTokenSecretName: string
	allowedHosts: Array<string>
}

type StoredIntegrationAuthorization = NonNullable<
	NonNullable<AccountIntegrationListItem['authorization']>
>

// Server-returned integration config used to prefill reconnects.
type StoredIntegrationConfig = Omit<
	AccountIntegrationListItem,
	| 'apiBaseUrl'
	| 'authorization'
	| 'clientSecretSecretName'
	| 'createdAt'
	| 'refreshTokenSecretName'
	| 'requiredHosts'
	| 'updatedAt'
	| 'appSlug'
	| 'provider'
	| 'appLabel'
	| 'accountLabel'
> & {
	apiBaseUrl: string | null
	clientSecretSecretName: string | null
	refreshTokenSecretName: string | null
	requiredHosts: Array<string>
	usePkce?: boolean | null
	/** Omitted when unset so persisted JSON stays sparse (matches pre-import shape). */
	tokenExchangeStyle?: TokenExchangeStyle | null
	authorization?: StoredIntegrationAuthorization | null
}

type OAuthExchangeResult =
	| { ok: true; data: Record<string, unknown>; status: number }
	| { ok: false; status: number; error: string }

type SaveSecretResult = { ok: true } | { ok: false; error: string }

type SaveOauthAppResult =
	| { ok: true; clientId: string }
	| { ok: false; error: string }

type ConnectOauthHostApprovalLink = {
	secretName: string
	host: string
	approvalUrl: string
}

type ConnectOauthPackageSuggestion = {
	listingId: string
	name: string
	kodyId: string
	description: string
	trusted: boolean
	publicUrl: string
	forkPrompt: string
}

type ConnectOauthNextSteps = {
	guidance: string
	integrationName: string
	suggestions: Array<ConnectOauthPackageSuggestion>
	createHelpersCta: {
		label: string
		prompt: string
	}
}

type OAuthCallback =
	| { kind: 'none' }
	| { kind: 'error'; error: string; description: string | null }
	| { kind: 'success'; code: string; state: string | null }

export function ConnectOauthRoute(handle: Handle) {
	type StatusTone = 'info' | 'warn' | 'error'

	let statusMessage = 'Ready to connect.'
	let statusTone: StatusTone = 'info'
	let currentStep: 'setup' | 'connect' | 'callback' | 'success' = 'setup'
	let config: ConnectOauthConfig | null = null
	let existingIntegrationConfig: StoredIntegrationConfig | null = null
	let accessTokenSaved = false
	let refreshTokenSaved = false
	let hasConfigError = false
	let connectOauthHandled = false
	let hostApprovalLinks: Array<ConnectOauthHostApprovalLink> = []
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
				error instanceof Error ? error.message : 'Unable to approve all hosts.',
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
		} catch {}
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
		const response = await fetch(
			`/account/integrations.json?name=${encodeURIComponent(queryConfig.providerKey)}`,
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
		if (!response.ok || payload?.ok !== true || !payload.integration) {
			return null
		}
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
		})
		if (setupStatus.isReady) {
			setStatus(
				existingIntegrationConfig
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
		} finally {
			submitting = false
			update()
		}
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
				error instanceof Error ? error.message : 'Unable to start OAuth.',
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
		const valid = validateState(getStateKey(config.providerKey), callback.state)
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
		return
	}

	const renderRedirectUriCard = () => {
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
								await readExistingIntegrationConfig(queryConfig),
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
		const existingIntegration = await readExistingIntegrationConfig(queryConfig)
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
					<h1 mix={css(pageTitleCss)}>Connect {config.provider}</h1>
					<p mix={css(pageDescriptionCss)}>
						Follow the steps below to connect your account using OAuth.
					</p>
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
						{existingIntegrationConfig && hasStoredClientId ? (
							<p mix={css(descriptionCss)}>
								Using stored client ID
								{config.flow === 'confidential' && hasStoredClientSecret
									? ` and stored client secret ${config.clientSecretSecretName ?? ''}.`
									: '.'}
							</p>
						) : null}
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

function normalizeHosts(hosts: Array<string>) {
	return Array.from(
		new Set(
			hosts
				.map((host) => host.trim().toLowerCase())
				.filter((host) => host.length > 0),
		),
	).sort()
}

export function toStoredIntegrationConfig(
	integration: AccountIntegrationListItem,
): StoredIntegrationConfig {
	return {
		name: integration.name,
		tokenUrl: integration.tokenUrl,
		apiBaseUrl: integration.apiBaseUrl?.trim() || null,
		...(integration.flow ? { flow: integration.flow } : {}),
		usePkce:
			typeof integration.usePkce === 'boolean' ? integration.usePkce : null,
		clientId: integration.clientId,
		clientSecretSecretName: integration.clientSecretSecretName?.trim() || null,
		accessTokenSecretName: integration.accessTokenSecretName,
		refreshTokenSecretName: integration.refreshTokenSecretName?.trim() || null,
		requiredHosts: normalizeHosts(integration.requiredHosts ?? []),
		...(integration.tokenExchangeStyle
			? { tokenExchangeStyle: integration.tokenExchangeStyle }
			: {}),
		authorization: integration.authorization
			? {
					authorizeUrl: integration.authorization.authorizeUrl,
					scopes: integration.authorization.scopes,
					scopeSeparator: integration.authorization.scopeSeparator ?? null,
					extraAuthorizeParams:
						integration.authorization.extraAuthorizeParams ?? {},
				}
			: null,
	}
}

/**
 * Parses a stored/server integration payload for reconnect helpers and tests.
 * Accepts either a JSON string or an already-decoded object with inline
 * `clientId` (the first-class integrations table shape).
 */
export function parseStoredIntegrationConfig(
	raw: string | Record<string, unknown>,
	fallbackProvider: string | null,
): StoredIntegrationConfig | null {
	try {
		const parsed =
			typeof raw === 'string'
				? (JSON.parse(raw) as Record<string, unknown>)
				: raw
		const name =
			typeof parsed.name === 'string' && parsed.name.trim()
				? parsed.name.trim()
				: (fallbackProvider?.trim() ?? '')
		const tokenUrl =
			typeof parsed.tokenUrl === 'string' ? parsed.tokenUrl.trim() : ''
		const flow = parsed.flow === 'confidential' ? 'confidential' : 'pkce'
		const usePkce = typeof parsed.usePkce === 'boolean' ? parsed.usePkce : null
		const clientId =
			typeof parsed.clientId === 'string' ? parsed.clientId.trim() : ''
		const accessTokenSecretName =
			typeof parsed.accessTokenSecretName === 'string'
				? parsed.accessTokenSecretName.trim()
				: ''
		const refreshTokenSecretName =
			typeof parsed.refreshTokenSecretName === 'string' &&
			parsed.refreshTokenSecretName.trim()
				? parsed.refreshTokenSecretName.trim()
				: null
		const clientSecretSecretName =
			typeof parsed.clientSecretSecretName === 'string' &&
			parsed.clientSecretSecretName.trim()
				? parsed.clientSecretSecretName.trim()
				: null
		const tokenExchangeStyle = parseTokenExchangeStyle(
			parsed.tokenExchangeStyle,
		)
		const requiredHosts = Array.isArray(parsed.requiredHosts)
			? parsed.requiredHosts.filter(
					(value): value is string => typeof value === 'string',
				)
			: []
		const authorization = parseStoredIntegrationAuthorization(
			parsed.authorization,
		)
		if (!name || !tokenUrl || !clientId || !accessTokenSecretName) {
			return null
		}
		return {
			name,
			tokenUrl,
			apiBaseUrl:
				typeof parsed.apiBaseUrl === 'string' && parsed.apiBaseUrl.trim()
					? parsed.apiBaseUrl.trim()
					: null,
			flow,
			usePkce,
			clientId,
			clientSecretSecretName,
			accessTokenSecretName,
			refreshTokenSecretName,
			requiredHosts: normalizeHosts(requiredHosts),
			...(tokenExchangeStyle ? { tokenExchangeStyle } : {}),
			authorization,
		}
	} catch {
		return null
	}
}

function parseStoredIntegrationAuthorization(
	raw: unknown,
): StoredIntegrationAuthorization | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const parsed = raw as Record<string, unknown>
	const authorizeUrl =
		typeof parsed.authorizeUrl === 'string' ? parsed.authorizeUrl.trim() : ''
	if (
		!authorizeUrl ||
		!isSafeExternalUrl(authorizeUrl) ||
		!safeParseHost(authorizeUrl)
	) {
		return null
	}
	const scopes = Array.isArray(parsed.scopes)
		? parsed.scopes.filter(
				(value): value is string => typeof value === 'string' && Boolean(value),
			)
		: []
	const scopeSeparator =
		typeof parsed.scopeSeparator === 'string' && parsed.scopeSeparator
			? parsed.scopeSeparator
			: null
	const extraAuthorizeParams =
		parsed.extraAuthorizeParams &&
		typeof parsed.extraAuthorizeParams === 'object' &&
		!Array.isArray(parsed.extraAuthorizeParams)
			? Object.fromEntries(
					Object.entries(parsed.extraAuthorizeParams)
						.filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === 'string',
						)
						.map(([key, value]) => [key, value]),
				)
			: {}
	return {
		authorizeUrl,
		scopes,
		scopeSeparator,
		extraAuthorizeParams,
	}
}

export function mergeConnectOauthConfig(input: {
	queryConfig: ConnectOauthQueryConfig
	storedIntegration: StoredIntegrationConfig | null
}): ConnectOauthConfig | null {
	const provider =
		input.storedIntegration?.name.trim() || input.queryConfig.provider.trim()
	const providerKey = normalizeProviderKey(
		provider || input.queryConfig.providerKey,
	)
	const authorizeUrl =
		input.queryConfig.authorizeUrl ??
		input.storedIntegration?.authorization?.authorizeUrl ??
		null
	const authorizeHost = authorizeUrl ? safeParseHost(authorizeUrl) : null
	// Empty string means "family prefill could not agree" — fall through to
	// the query/default rather than wiping a known endpoint.
	const tokenUrl =
		input.storedIntegration?.tokenUrl?.trim() ||
		input.queryConfig.tokenUrl ||
		null
	const tokenHost = tokenUrl ? safeParseHost(tokenUrl) : null
	if (
		!provider ||
		!authorizeUrl ||
		!authorizeHost ||
		!tokenUrl ||
		!tokenHost ||
		!providerKey
	) {
		return null
	}
	const flow =
		input.storedIntegration?.flow ??
		input.queryConfig.flow ??
		defaultConnectOauthFlow(tokenUrl)
	const usePkce =
		input.queryConfig.usePkce ??
		input.storedIntegration?.usePkce ??
		defaultConnectOauthUsePkce({ flow, tokenUrl })
	const scopes = resolveConnectOauthScopes(input)
	const extraAuthorizeParams = resolveConnectOauthExtraAuthorizeParams(input)
	const allowedHosts = normalizeHosts([
		tokenHost,
		...input.queryConfig.allowedHosts,
		...(input.storedIntegration?.requiredHosts ?? []),
	])
	if (allowedHosts.length === 0) return null
	return {
		provider,
		providerKey,
		authorizeHost,
		tokenHost,
		authorizeUrl,
		tokenUrl,
		apiBaseUrl:
			input.storedIntegration?.apiBaseUrl ?? input.queryConfig.apiBaseUrl,
		scopes,
		flow,
		usePkce,
		tokenExchangeStyle: resolveConnectOauthTokenExchangeStyle({
			tokenUrl,
			queryStyle: input.queryConfig.tokenExchangeStyle,
			storedStyle: input.storedIntegration?.tokenExchangeStyle ?? null,
		}),
		scopeSeparator:
			input.queryConfig.scopeSeparator ??
			input.storedIntegration?.authorization?.scopeSeparator ??
			' ',
		extraAuthorizeParams,
		providerSetupInstructions: input.queryConfig.providerSetupInstructions,
		dashboardUrl: input.queryConfig.dashboardUrl,
		clientId: input.storedIntegration?.clientId?.trim() || '',
		clientSecretSecretName:
			flow === 'confidential'
				? (input.storedIntegration?.clientSecretSecretName ??
					`${providerKey}ClientSecret`)
				: null,
		accessTokenSecretName:
			input.storedIntegration?.accessTokenSecretName ??
			`${providerKey}AccessToken`,
		refreshTokenSecretName:
			input.storedIntegration?.refreshTokenSecretName ??
			`${providerKey}RefreshToken`,
		allowedHosts,
	}
}

function resolveConnectOauthScopes(input: {
	queryConfig: ConnectOauthQueryConfig
	storedIntegration: StoredIntegrationConfig | null
}) {
	if (input.queryConfig.scopes && input.queryConfig.scopes.length > 0) {
		return input.queryConfig.scopes
	}
	return input.storedIntegration?.authorization?.scopes ?? []
}

function resolveConnectOauthExtraAuthorizeParams(input: {
	queryConfig: ConnectOauthQueryConfig
	storedIntegration: StoredIntegrationConfig | null
}) {
	const queryParams = input.queryConfig.extraAuthorizeParams
	if (queryParams && Object.keys(queryParams).length > 0) {
		return queryParams
	}
	return input.storedIntegration?.authorization?.extraAuthorizeParams ?? {}
}

/**
 * Parses the sessionStorage config persisted before redirecting to the
 * provider. Validation is deliberately strict with no back-compat for older
 * shapes: the snapshot lives for a single authorize round trip, so a stale
 * shape can only exist for a flow in-flight across a deploy, and the recovery
 * is simply restarting the connect flow from its URL.
 */
export function parseSessionConnectOauthConfig(
	raw: string,
): ConnectOauthConfig | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== 'object') return null
	const record = parsed as Record<string, unknown>
	const isValid =
		typeof record.provider === 'string' &&
		typeof record.providerKey === 'string' &&
		typeof record.authorizeUrl === 'string' &&
		typeof record.tokenUrl === 'string' &&
		typeof record.authorizeHost === 'string' &&
		typeof record.tokenHost === 'string' &&
		(record.flow === 'pkce' || record.flow === 'confidential') &&
		typeof record.usePkce === 'boolean' &&
		typeof record.scopeSeparator === 'string' &&
		typeof record.clientId === 'string' &&
		typeof record.accessTokenSecretName === 'string' &&
		Array.isArray(record.scopes) &&
		Array.isArray(record.allowedHosts) &&
		record.scopes.every((value) => typeof value === 'string') &&
		record.allowedHosts.every((value) => typeof value === 'string')
	if (!isValid) return null
	return record as unknown as ConnectOauthConfig
}

export function summarizeStoredSetupState(input: {
	flow: OAuthFlow
	clientId: string | null
	hasStoredClientSecret: boolean
}) {
	const missingFields: Array<string> = []
	if (!input.clientId?.trim()) missingFields.push('client ID')
	if (input.flow === 'confidential' && !input.hasStoredClientSecret) {
		missingFields.push('client secret')
	}
	return {
		missingFields,
		isReady: missingFields.length === 0,
	}
}

/**
 * Distinguish real Kody session expiry (401 Unauthorized) from provider token
 * exchange failures that historically leaked through as HTTP 401.
 */
export function formatOAuthExchangeFailure(input: {
	status: number
	data: Record<string, unknown> | null
}): { treatAsSessionExpired: boolean; error: string } {
	if (isOAuthExchangeSessionExpired(input)) {
		return { treatAsSessionExpired: true, error: 'Session expired.' }
	}
	const errorDescription =
		typeof input.data?.error_description === 'string' &&
		input.data.error_description.trim()
			? input.data.error_description.trim()
			: typeof input.data?.error === 'string' && input.data.error.trim()
				? input.data.error.trim()
				: null
	return {
		treatAsSessionExpired: false,
		error: errorDescription ?? 'Token exchange failed.',
	}
}

export function isOAuthExchangeSessionExpired(input: {
	status: number
	data: Record<string, unknown> | null
}) {
	if (input.status !== 401) return false
	if (hasProviderOAuthExchangeError(input.data)) return false
	return true
}

function hasProviderOAuthExchangeError(data: Record<string, unknown> | null) {
	if (!data) return false
	if (typeof data.providerStatus === 'number') return true
	if (
		typeof data.error_description === 'string' &&
		data.error_description.trim()
	) {
		return true
	}
	return (
		typeof data.error === 'string' &&
		data.error.trim() !== '' &&
		data.error !== 'Unauthorized.'
	)
}

function resolveConnectOauthTokenExchangeStyle(input: {
	tokenUrl: string
	queryStyle: TokenExchangeStyle | null
	storedStyle: TokenExchangeStyle | null
}): TokenExchangeStyle {
	if (input.queryStyle) return input.queryStyle
	if (input.storedStyle) return input.storedStyle
	const host = safeParseHost(input.tokenUrl)
	if (host === 'api.notion.com') return 'basic-json'
	if (host === 'api.canva.com') return 'basic-form'
	return 'form'
}

/**
 * Hosts that require a confidential client even though the default flow is
 * PKCE-only. Canva requires both S256 PKCE and a client secret.
 */
function defaultConnectOauthFlow(tokenUrl: string): OAuthFlow {
	return safeParseHost(tokenUrl) === 'api.canva.com' ? 'confidential' : 'pkce'
}

function defaultConnectOauthUsePkce(input: {
	flow: OAuthFlow
	tokenUrl: string
}): boolean {
	if (input.flow === 'pkce') return true
	return safeParseHost(input.tokenUrl) === 'api.canva.com'
}

function parseTokenExchangeStyle(raw: unknown): TokenExchangeStyle | null {
	return raw === 'form' || raw === 'basic-json' || raw === 'basic-form'
		? raw
		: null
}

function parseOptionalBoolean(raw: string | null): boolean | null {
	if (raw == null) return null
	const normalized = raw.trim().toLowerCase()
	if (normalized === 'true' || normalized === '1') return true
	if (normalized === 'false' || normalized === '0') return false
	return null
}

function formatMissingSetupFields(missingFields: Array<string>) {
	if (missingFields.length === 0) return 'Ready to connect.'
	if (missingFields.length === 1) {
		return `Enter your ${missingFields[0]} to continue.`
	}
	return `Enter your ${missingFields.slice(0, -1).join(', ')} and ${missingFields.at(-1)} to continue.`
}

function parseExtraParams(raw: string | null) {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return Object.fromEntries(
				Object.entries(parsed).map(([key, value]) => [key, String(value)]),
			) as Record<string, string>
		}
	} catch {}
	return {}
}

function parseAllowedHosts(raw: string | null) {
	if (!raw) return []
	return raw
		.split(/[\s,]+/)
		.map((host) => host.trim())
		.filter(Boolean)
}

function parseHostApprovalLinks(
	raw: unknown,
): Array<ConnectOauthHostApprovalLink> {
	if (!Array.isArray(raw)) return []
	return raw.filter(
		(entry): entry is ConnectOauthHostApprovalLink =>
			Boolean(entry) &&
			typeof entry === 'object' &&
			typeof (entry as { secretName?: unknown }).secretName === 'string' &&
			typeof (entry as { host?: unknown }).host === 'string' &&
			typeof (entry as { approvalUrl?: unknown }).approvalUrl === 'string' &&
			isSafeExternalUrl((entry as { approvalUrl?: string }).approvalUrl ?? ''),
	)
}

export function parseConnectOauthNextSteps(
	raw: unknown,
): ConnectOauthNextSteps | null {
	if (!raw || typeof raw !== 'object') return null
	const record = raw as Record<string, unknown>
	if (
		typeof record.guidance !== 'string' ||
		typeof record.integrationName !== 'string' ||
		!record.createHelpersCta ||
		typeof record.createHelpersCta !== 'object' ||
		!Array.isArray(record.suggestions)
	) {
		return null
	}
	const createHelpersCta = record.createHelpersCta as Record<string, unknown>
	if (
		typeof createHelpersCta.label !== 'string' ||
		typeof createHelpersCta.prompt !== 'string'
	) {
		return null
	}
	const suggestions = record.suggestions.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return []
		const suggestion = entry as Record<string, unknown>
		if (
			typeof suggestion.listingId !== 'string' ||
			typeof suggestion.name !== 'string' ||
			typeof suggestion.kodyId !== 'string' ||
			typeof suggestion.description !== 'string' ||
			typeof suggestion.trusted !== 'boolean' ||
			typeof suggestion.publicUrl !== 'string' ||
			typeof suggestion.forkPrompt !== 'string' ||
			!isSafeExternalUrl(suggestion.publicUrl)
		) {
			return []
		}
		return [
			{
				listingId: suggestion.listingId,
				name: suggestion.name,
				kodyId: suggestion.kodyId,
				description: suggestion.description,
				trusted: suggestion.trusted,
				publicUrl: suggestion.publicUrl,
				forkPrompt: suggestion.forkPrompt,
			} satisfies ConnectOauthPackageSuggestion,
		]
	})
	return {
		guidance: record.guidance,
		integrationName: record.integrationName,
		suggestions,
		createHelpersCta: {
			label: createHelpersCta.label,
			prompt: createHelpersCta.prompt,
		},
	}
}

function parseOptionalUrl(raw: string | null) {
	if (!raw) return null
	try {
		return new URL(raw).toString()
	} catch {
		return null
	}
}

function isSafeExternalUrl(raw: string) {
	try {
		const url = new URL(raw)
		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

function parseProviderSetupInstructions(raw: string | null) {
	if (!raw) return null
	const trimmed = raw.trim()
	if (!trimmed) return null
	if (trimmed.startsWith('base64:')) {
		return decodeBase64Payload(trimmed.slice('base64:'.length)) ?? trimmed
	}
	const decoded = decodeBase64Payload(trimmed)
	return decoded && isMostlyPrintable(decoded) ? decoded : trimmed
}

function decodeBase64Payload(raw: string) {
	if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) return null
	try {
		return new TextDecoder().decode(base64UrlToBytes(raw))
	} catch {
		return null
	}
}

function isMostlyPrintable(text: string) {
	if (!text) return false
	let printable = 0
	for (const char of text) {
		const code = char.charCodeAt(0)
		if (code === 9 || code === 10 || code === 13 || code >= 32) {
			printable += 1
		}
	}
	return printable / text.length > 0.85
}

async function createCodeChallenge(verifier: string) {
	const data = new TextEncoder().encode(verifier)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return bytesToBase64Url(new Uint8Array(digest))
}

function createCodeVerifier() {
	const bytes = new Uint8Array(64)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
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
