import { type Handle } from 'remix/component'
import { colors, radius, shadows, spacing } from '#client/styles/tokens.ts'

type OAuthFlow = 'pkce' | 'confidential'

type ConnectOauthQueryConfig = {
	provider: string
	providerKey: string
	authorizeHost: string
	authorizeUrl: string
	tokenUrl: string | null
	apiBaseUrl: string | null
	scopes: Array<string>
	flow: OAuthFlow | null
	scopeSeparator: string
	extraAuthorizeParams: Record<string, string>
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
	scopeSeparator: string
	extraAuthorizeParams: Record<string, string>
	providerSetupInstructions: string | null
	dashboardUrl: string | null
	clientIdValueName: string
	clientSecretSecretName: string | null
	accessTokenSecretName: string
	refreshTokenSecretName: string
	allowedHosts: Array<string>
}

type StoredConnectorConfig = {
	name: string
	tokenUrl: string
	apiBaseUrl: string | null
	flow: OAuthFlow
	clientIdValueName: string
	clientSecretSecretName: string | null
	accessTokenSecretName: string
	refreshTokenSecretName: string | null
	requiredHosts: Array<string>
}

type OAuthExchangeResult =
	| { ok: true; data: Record<string, unknown>; status: number }
	| { ok: false; status: number; error: string }

type SaveValueResult =
	| { ok: true; value: { value: string } }
	| { ok: false; error: string }

type SaveSecretResult = { ok: true } | { ok: false; error: string }

type ConnectOauthHostApprovalLink = {
	secretName: string
	host: string
	approvalUrl: string
}

type AccountSecretsListPayload = {
	ok: true
	secrets: Array<{ name: string; scope: string }>
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
	let existingConnectorConfig: StoredConnectorConfig | null = null
	let existingConnectorValueName: string | null = null
	let accessTokenSaved = false
	let refreshTokenSaved = false
	let hasConfigError = false
	let connectOauthHandled = false
	let hostApprovalLinks: Array<ConnectOauthHostApprovalLink> = []
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
		const authorizeUrl = readRequired('authorizeUrl')
		const tokenUrl = readOptional('tokenUrl')
		const apiBaseUrl = parseOptionalUrl(readOptional('apiBaseUrl'))
		if (!provider || !authorizeUrl) {
			hasConfigError = true
			setStatus('Missing required OAuth configuration parameters.', 'error')
			return null
		}
		const authorizeHost = safeParseHost(authorizeUrl)
		if (!authorizeHost) {
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
		let flow = (readOptional('flow') ?? 'pkce').toLowerCase()
		if (flow !== 'pkce' && flow !== 'confidential') flow = 'pkce'
		const scopes = parseScopes(readOptional('scopes'))
		const scopeSeparator = readOptional('scopeSeparator') ?? ' '
		const extraAuthorizeParams = parseExtraParams(
			readOptional('extraAuthorizeParams'),
		)
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
			flow: flow as OAuthFlow,
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

	const isConnectOauthConfig = (
		value: unknown,
	): value is ConnectOauthConfig => {
		if (!value || typeof value !== 'object') return false
		const record = value as Record<string, unknown>
		return (
			typeof record.provider === 'string' &&
			typeof record.providerKey === 'string' &&
			typeof record.authorizeUrl === 'string' &&
			typeof record.tokenUrl === 'string' &&
			typeof record.authorizeHost === 'string' &&
			typeof record.tokenHost === 'string' &&
			typeof record.flow === 'string' &&
			typeof record.scopeSeparator === 'string' &&
			typeof record.clientIdValueName === 'string' &&
			typeof record.accessTokenSecretName === 'string' &&
			Array.isArray(record.scopes) &&
			Array.isArray(record.allowedHosts) &&
			record.scopes.every((value) => typeof value === 'string') &&
			record.allowedHosts.every((value) => typeof value === 'string')
		)
	}

	const persistConfig = (nextConfig: ConnectOauthConfig) => {
		try {
			sessionStorage.setItem(configStorageKey, JSON.stringify(nextConfig))
		} catch {}
	}

	const readStoredConfig = (): ConnectOauthConfig | null => {
		if (typeof window === 'undefined') return null
		const raw = sessionStorage.getItem(configStorageKey)
		if (!raw) return null
		try {
			const parsed = JSON.parse(raw)
			return isConnectOauthConfig(parsed) ? parsed : null
		} catch {
			return null
		}
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
		const clientId = await readValue(nextConfig.clientIdValueName)
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
		if (nextConfig.flow === 'pkce') {
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

	const readValue = async (name: string) => {
		const response = await fetch('/account/secrets.json', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify({ action: 'value_get', name }),
		})
		const payload = await response.json().catch(() => null)
		if (!response.ok || payload?.ok !== true) return null
		return typeof payload.value?.value === 'string' ? payload.value.value : null
	}

	const listSecrets = async () => {
		const response = await fetch('/account/secrets.json', {
			method: 'GET',
			headers: {
				Accept: 'application/json',
			},
			credentials: 'include',
		})
		const payload = (await response
			.json()
			.catch(() => null)) as AccountSecretsListPayload | null
		if (
			!response.ok ||
			payload?.ok !== true ||
			!Array.isArray(payload.secrets)
		) {
			return null
		}
		return payload.secrets
	}

	const readExistingConnectorConfig = async (
		queryConfig: ConnectOauthQueryConfig,
	) => {
		for (const valueName of getConnectorValueCandidates(
			queryConfig.provider,
			queryConfig.providerKey,
		)) {
			const raw = await readValue(valueName)
			if (!raw) continue
			const parsed = parseStoredConnectorConfig(raw, queryConfig.provider)
			if (parsed) {
				return {
					valueName,
					connector: parsed,
				}
			}
		}
		return {
			valueName: null,
			connector: null,
		}
	}

	const initializeSetupState = async (nextConfig: ConnectOauthConfig) => {
		const clientId = await readValue(nextConfig.clientIdValueName)
		const secrets = nextConfig.clientSecretSecretName
			? await listSecrets()
			: null
		clientIdInput = clientId ?? ''
		clientSecretInput = ''
		hasStoredClientId = Boolean(clientId?.trim())
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
			clientId,
			hasStoredClientSecret,
		})
		if (setupStatus.isReady) {
			setStatus(
				existingConnectorConfig
					? 'Loaded your existing connector config and client credentials. Ready to connect.'
					: 'Loaded your existing OAuth client configuration. Ready to connect.',
			)
			setStep('connect')
			return
		}
		const missingDetails = formatMissingSetupFields(setupStatus.missingFields)
		setStatus(
			existingConnectorConfig
				? `Loaded your existing connector config. ${missingDetails}`
				: missingDetails,
		)
		setStep('setup')
	}

	const saveValue = async (
		name: string,
		value: string,
		description: string,
	): Promise<SaveValueResult> => {
		const response = await fetch('/account/secrets.json', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify({
				action: 'value_set',
				name,
				value,
				description,
			}),
		})
		const payload = await response.json().catch(() => null)
		if (!response.ok || payload?.ok !== true || !payload.value?.value) {
			return { ok: false, error: payload?.error || 'Unable to save value.' }
		}
		return { ok: true, value: { value: String(payload.value.value) } }
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
		const clientId = await readValue(nextConfig.clientIdValueName)
		if (!clientId) {
			return { ok: false, status: 0, error: 'Missing client ID.' }
		}
		params.set('client_id', clientId)
		params.set('code', code)
		params.set('redirect_uri', getRedirectUri())
		if (nextConfig.flow === 'pkce') {
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
		if (!response.ok || !data) {
			const errorDescription =
				typeof data?.error_description === 'string'
					? data.error_description
					: typeof data?.error === 'string'
						? data.error
						: null
			return {
				ok: false,
				status: response.status,
				error: errorDescription ?? 'Token exchange failed.',
			}
		}
		return { ok: true, data, status: response.status }
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
			const clientIdResult = await saveValue(
				config.clientIdValueName,
				clientId,
				`${config.provider} OAuth client ID`,
			)
			if (!clientIdResult.ok) {
				setStatus(clientIdResult.error, 'error')
				return
			}
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
				tokenUrl: config.tokenUrl,
				apiBaseUrl: config.apiBaseUrl,
				flow: config.flow,
				clientIdValueName: config.clientIdValueName,
				clientSecretSecretName: config.clientSecretSecretName,
				allowedHosts: config.allowedHosts,
				accessTokenSecretName: config.accessTokenSecretName,
				refreshTokenSecretName: config.refreshTokenSecretName,
				tokenPayload: exchange.data,
			}),
		})
		const payload = await response.json().catch(() => null)
		if (!response.ok || payload?.ok !== true) {
			setStatus(payload?.error || 'Unable to save OAuth tokens.', 'error')
			setStep('connect')
			return
		}
		accessTokenSaved = payload.accessTokenSaved === true
		refreshTokenSaved = payload.refreshTokenSaved === true
		setHostApprovalLinks(parseHostApprovalLinks(payload.hostApprovalLinks))
		setStatus('OAuth tokens saved.', 'info')
		setStep('success')
		return
	}

	const renderProviderInstructions = () => {
		if (!config) return null
		const instructions = config.providerSetupInstructions
		if (instructions && instructions.trim()) {
			return (
				<p
					css={{
						whiteSpace: 'pre-wrap',
						backgroundColor: colors.surface,
						border: `1px solid ${colors.border}`,
						padding: spacing.md,
						borderRadius: radius.md,
						color: colors.textMuted,
					}}
				>
					{instructions}
				</p>
			)
		}
		return (
			<p css={{ color: colors.textMuted }}>
				Create an OAuth app with your provider and enter the Client ID below.
			</p>
		)
	}

	const renderAllowedHosts = () => {
		if (!config) return null
		return (
			<section
				css={{
					padding: spacing.md,
					borderRadius: radius.md,
					border: `1px solid ${colors.border}`,
					backgroundColor: colors.surface,
					display: 'grid',
					gap: spacing.xs,
				}}
			>
				<h3 css={{ margin: 0 }}>Allowed hosts</h3>
				<p css={{ margin: 0, color: colors.textMuted }}>
					These hosts will be approved for the saved secrets. Host approvals are
					never automatic.
				</p>
				<ul css={{ margin: 0, paddingLeft: spacing.lg }}>
					{config.allowedHosts.map((host) => (
						<li key={host}>{host}</li>
					))}
				</ul>
			</section>
		)
	}

	const renderExistingConnectorConfig = () => {
		if (!existingConnectorConfig) return null
		return (
			<section
				css={{
					padding: spacing.md,
					borderRadius: radius.md,
					border: `1px solid ${colors.border}`,
					backgroundColor: colors.surface,
					display: 'grid',
					gap: spacing.sm,
				}}
			>
				<h2 css={{ margin: 0 }}>Existing connector config</h2>
				<p css={{ margin: 0, color: colors.textMuted }}>
					Loaded from{' '}
					<code>
						{existingConnectorValueName ??
							buildConnectorValueName(config?.provider ?? '')}
					</code>
					.
				</p>
				<p css={{ margin: 0 }}>
					Flow: <strong>{existingConnectorConfig.flow}</strong>
				</p>
				<p css={{ margin: 0 }}>
					Token URL: <code>{existingConnectorConfig.tokenUrl}</code>
				</p>
				{existingConnectorConfig.apiBaseUrl ? (
					<p css={{ margin: 0 }}>
						API base URL: <code>{existingConnectorConfig.apiBaseUrl}</code>
					</p>
				) : null}
				<p css={{ margin: 0 }}>
					Client ID value:{' '}
					<code>{existingConnectorConfig.clientIdValueName}</code>
				</p>
				<p css={{ margin: 0 }}>
					Client secret secret:{' '}
					<code>
						{existingConnectorConfig.clientSecretSecretName ?? 'Not used'}
					</code>
				</p>
				<p css={{ margin: 0 }}>
					Access token secret:{' '}
					<code>{existingConnectorConfig.accessTokenSecretName}</code>
				</p>
				<p css={{ margin: 0 }}>
					Refresh token secret:{' '}
					<code>
						{existingConnectorConfig.refreshTokenSecretName ?? 'Not used'}
					</code>
				</p>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<strong>Required hosts</strong>
					{existingConnectorConfig.requiredHosts.length > 0 ? (
						<ul css={{ margin: 0, paddingLeft: spacing.lg }}>
							{existingConnectorConfig.requiredHosts.map((host) => (
								<li key={host}>{host}</li>
							))}
						</ul>
					) : (
						<p css={{ margin: 0, color: colors.textMuted }}>None configured.</p>
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
							storedConnector: (await readExistingConnectorConfig(queryConfig))
								.connector,
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
		const existingConnector = await readExistingConnectorConfig(queryConfig)
		existingConnectorConfig = existingConnector.connector
		existingConnectorValueName = existingConnector.valueName
		const nextConfig = mergeConnectOauthConfig({
			queryConfig,
			storedConnector: existingConnector.connector,
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
				<section css={{ padding: spacing.lg }}>
					<h1 css={{ margin: 0 }}>Connect OAuth</h1>
					<p css={{ color: colors.textMuted }}>{statusMessage}</p>
				</section>
			)
		}
		return (
			<section
				css={{
					maxWidth: '60rem',
					margin: '0 auto',
					display: 'grid',
					gap: spacing.lg,
				}}
			>
				<header>
					<h1 css={{ margin: 0 }}>Connect {config.provider}</h1>
					<p css={{ color: colors.textMuted }}>
						Follow the steps below to connect your account using OAuth.
					</p>
				</header>
				<section
					css={{
						padding: spacing.md,
						borderRadius: radius.md,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.surface,
						boxShadow: shadows.sm,
					}}
				>
					<strong>status</strong>
					<p
						css={{
							margin: `${spacing.xs} 0 0`,
							color: statusTone === 'error' ? colors.danger : colors.textMuted,
						}}
					>
						{statusMessage}
					</p>
				</section>
				<section
					css={{
						padding: spacing.md,
						borderRadius: radius.md,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.surface,
						display: 'grid',
						gap: spacing.sm,
					}}
				>
					<h2 css={{ margin: 0 }}>Provider details</h2>
					<p css={{ margin: 0 }}>
						Authorize URL: <code>{config.authorizeUrl}</code>
					</p>
					<p css={{ margin: 0 }}>
						Token URL: <code>{config.tokenUrl}</code>
					</p>
					<p css={{ margin: 0 }}>Flow: {config.flow}</p>
					<p css={{ margin: 0 }}>
						Scope: {config.scopes.length ? config.scopes.join(' ') : 'None'}
					</p>
					{config.dashboardUrl && isSafeExternalUrl(config.dashboardUrl) ? (
						<a
							href={config.dashboardUrl}
							target="_blank"
							rel="noreferrer noopener"
						>
							Open provider dashboard
						</a>
					) : null}
				</section>
				{renderExistingConnectorConfig()}
				{currentStep === 'setup' ? (
					<section
						css={{
							padding: spacing.md,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.surface,
							display: 'grid',
							gap: spacing.md,
						}}
					>
						<h2 css={{ margin: 0 }}>
							1. {existingConnectorConfig ? 'Review' : 'Save'} OAuth client
							configuration
						</h2>
						{renderProviderInstructions()}
						{renderAllowedHosts()}
						<form
							on={{ submit: handleSetupSubmit }}
							css={{ display: 'grid', gap: spacing.md }}
						>
							<label>
								<span>Client ID</span>
								<input
									name="clientId"
									required
									value={clientIdInput}
									on={{
										input: (event) => {
											clientIdInput = event.currentTarget.value
											update()
										},
									}}
								/>
							</label>
							<p css={{ margin: 0, color: colors.textMuted }}>
								Saved as <code>{config.clientIdValueName}</code>
								{hasStoredClientId ? '.' : ' after you continue.'}
							</p>
							{config.flow === 'confidential' ? (
								hasStoredClientSecret && !revealStoredClientSecretField ? (
									<section
										css={{
											padding: spacing.md,
											borderRadius: radius.md,
											border: `1px solid ${colors.border}`,
											backgroundColor: colors.surface,
											display: 'grid',
											gap: spacing.sm,
										}}
									>
										<p css={{ margin: 0 }}>
											Using the stored client secret in{' '}
											<code>
												{config.clientSecretSecretName ?? 'unknown secret'}
											</code>
											.
										</p>
										<p css={{ margin: 0, color: colors.textMuted }}>
											You can continue without re-entering it.
										</p>
										<button
											type="button"
											on={{
												click: () => {
													revealStoredClientSecretField = true
													update()
												},
											}}
										>
											Replace stored client secret
										</button>
									</section>
								) : (
									<label>
										<span>Client Secret</span>
										<input
											name="clientSecret"
											type="password"
											required
											value={clientSecretInput}
											on={{
												input: (event) => {
													clientSecretInput = event.currentTarget.value
													update()
												},
											}}
										/>
									</label>
								)
							) : null}
							<button type="submit" disabled={submitting}>
								Save configuration
							</button>
						</form>
					</section>
				) : null}
				{currentStep === 'connect' ? (
					<section
						css={{
							padding: spacing.md,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.surface,
							display: 'grid',
							gap: spacing.sm,
						}}
					>
						<h2 css={{ margin: 0 }}>2. Connect</h2>
						<p css={{ margin: 0 }}>
							Start the OAuth flow. You will be redirected to the provider.
						</p>
						{existingConnectorConfig ? (
							<p css={{ margin: 0, color: colors.textMuted }}>
								Using stored client ID <code>{config.clientIdValueName}</code>
								{config.flow === 'confidential' && hasStoredClientSecret
									? ` and stored client secret ${config.clientSecretSecretName ?? ''}.`
									: '.'}
							</p>
						) : null}
						<button
							type="button"
							on={{ click: () => void handleConnect() }}
							disabled={submitting}
						>
							Connect {config.provider}
						</button>
					</section>
				) : null}
				{currentStep === 'success' ? (
					<section
						css={{
							padding: spacing.md,
							borderRadius: radius.md,
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.surface,
							display: 'grid',
							gap: spacing.sm,
						}}
					>
						<h2 css={{ margin: 0 }}>4. Success</h2>
						<p css={{ margin: 0 }}>
							Access token saved:{' '}
							<strong>{accessTokenSaved ? 'Yes' : 'No'}</strong>
						</p>
						<p css={{ margin: 0 }}>
							Refresh token saved:{' '}
							<strong>{refreshTokenSaved ? 'Yes' : 'No'}</strong>
						</p>
						<h3 css={{ margin: `${spacing.sm} 0 0` }}>Host approvals</h3>
						<p css={{ margin: 0 }}>
							Hosts are never auto-approved. Review these allowed hosts in your
							account secrets.
						</p>
						<ul>
							{config.allowedHosts.map((host) => (
								<li key={host}>{host}</li>
							))}
						</ul>
						{hostApprovalLinks.length > 0 ? (
							<div css={{ display: 'grid', gap: spacing.xs }}>
								<p css={{ margin: 0, color: colors.textMuted }}>
									Approve each token host directly:
								</p>
								<ul css={{ margin: 0, paddingLeft: spacing.lg }}>
									{hostApprovalLinks.map((link) => (
										<li key={`${link.secretName}:${link.host}`}>
											<a
												href={link.approvalUrl}
												target="_blank"
												rel="noreferrer"
											>
												Approve <code>{link.host}</code> for{' '}
												<code>{link.secretName}</code>
											</a>
										</li>
									))}
								</ul>
							</div>
						) : null}
						<a href="/account/secrets" target="_blank" rel="noreferrer">
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

export function normalizeHosts(hosts: Array<string>) {
	return Array.from(
		new Set(
			hosts
				.map((host) => host.trim().toLowerCase())
				.filter((host) => host.length > 0),
		),
	).sort()
}

export function buildConnectorValueName(provider: string) {
	return `_connector:${provider}`
}

export function getConnectorValueCandidates(
	provider: string,
	providerKey: string,
) {
	return Array.from(
		new Set(
			[provider.trim(), providerKey.trim()]
				.filter((value) => value.length > 0)
				.map((value) => buildConnectorValueName(value)),
		),
	)
}

export function parseStoredConnectorConfig(
	raw: string,
	fallbackProvider: string | null,
): StoredConnectorConfig | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const name =
			typeof parsed.name === 'string' && parsed.name.trim()
				? parsed.name.trim()
				: (fallbackProvider?.trim() ?? '')
		const tokenUrl =
			typeof parsed.tokenUrl === 'string' ? parsed.tokenUrl.trim() : ''
		const flow = parsed.flow === 'confidential' ? 'confidential' : 'pkce'
		const clientIdValueName =
			typeof parsed.clientIdValueName === 'string'
				? parsed.clientIdValueName.trim()
				: ''
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
		const requiredHosts = Array.isArray(parsed.requiredHosts)
			? parsed.requiredHosts.filter(
					(value): value is string => typeof value === 'string',
				)
			: []
		if (!name || !tokenUrl || !clientIdValueName || !accessTokenSecretName) {
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
			clientIdValueName,
			clientSecretSecretName,
			accessTokenSecretName,
			refreshTokenSecretName,
			requiredHosts: normalizeHosts(requiredHosts),
		}
	} catch {
		return null
	}
}

export function mergeConnectOauthConfig(input: {
	queryConfig: ConnectOauthQueryConfig
	storedConnector: StoredConnectorConfig | null
}): ConnectOauthConfig | null {
	const provider =
		input.storedConnector?.name.trim() || input.queryConfig.provider.trim()
	const providerKey = normalizeProviderKey(
		provider || input.queryConfig.providerKey,
	)
	const authorizeHost = safeParseHost(input.queryConfig.authorizeUrl)
	const tokenUrl = input.storedConnector?.tokenUrl ?? input.queryConfig.tokenUrl
	const tokenHost = tokenUrl ? safeParseHost(tokenUrl) : null
	if (!provider || !authorizeHost || !tokenUrl || !tokenHost || !providerKey) {
		return null
	}
	const flow = input.storedConnector?.flow ?? input.queryConfig.flow ?? 'pkce'
	const allowedHosts = normalizeHosts([
		tokenHost,
		...input.queryConfig.allowedHosts,
		...(input.storedConnector?.requiredHosts ?? []),
	])
	if (allowedHosts.length === 0) return null
	return {
		provider,
		providerKey,
		authorizeHost,
		tokenHost,
		authorizeUrl: input.queryConfig.authorizeUrl,
		tokenUrl,
		apiBaseUrl:
			input.storedConnector?.apiBaseUrl ?? input.queryConfig.apiBaseUrl,
		scopes: input.queryConfig.scopes,
		flow,
		scopeSeparator: input.queryConfig.scopeSeparator,
		extraAuthorizeParams: input.queryConfig.extraAuthorizeParams,
		providerSetupInstructions: input.queryConfig.providerSetupInstructions,
		dashboardUrl: input.queryConfig.dashboardUrl,
		clientIdValueName:
			input.storedConnector?.clientIdValueName ?? `${providerKey}-client-id`,
		clientSecretSecretName:
			flow === 'confidential'
				? (input.storedConnector?.clientSecretSecretName ??
					`${providerKey}ClientSecret`)
				: null,
		accessTokenSecretName:
			input.storedConnector?.accessTokenSecretName ??
			`${providerKey}AccessToken`,
		refreshTokenSecretName:
			input.storedConnector?.refreshTokenSecretName ??
			`${providerKey}RefreshToken`,
		allowedHosts,
	}
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
			typeof (entry as { approvalUrl?: unknown }).approvalUrl === 'string',
	)
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

function safeParseHost(raw: string) {
	try {
		return new URL(raw).hostname
	} catch {
		return null
	}
}

function normalizeProviderKey(value: string) {
	const normalized = value.trim().toLowerCase()
	return normalized.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
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
	const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
	if (!/^[A-Za-z0-9+/=]+$/.test(padded)) return null
	try {
		const binary = atob(padded)
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
		return new TextDecoder().decode(bytes)
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
	return base64UrlEncode(digest)
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
	let text = ''
	for (const byte of bytes) {
		text += String.fromCharCode(byte)
	}
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function createCodeVerifier() {
	const bytes = new Uint8Array(64)
	crypto.getRandomValues(bytes)
	return base64UrlEncode(bytes)
}
