import {
	type AccountIntegrationDetailLoaderData,
	type ConnectOauthExistingConnection,
	type ConnectOauthLoaderData,
} from '#universal/loader-data.ts'
import { type Handle, css } from 'remix/ui'
import {
	resolveOauthScopeMenu,
	uniqueOauthScopes,
} from '#universal/oauth-scopes.ts'
import { isConnectOauthCallbackUrl } from '#universal/oauth-connect.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	buildHostApprovalRequestUrl,
	submitApprovalRequest,
} from '#client/routes/account-approval-shared.ts'
import { ProviderMark } from '#client/provider-icons.tsx'
import {
	pageDescriptionCss,
	pageTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	renderAdvancedDetails,
	renderRedirectUriCard,
	renderSuccessAdvancedDetails,
} from './connect-oauth-detail.tsx'
import {
	ConnectOauthCredentialsForm,
	renderConnectStep,
	renderSuccessCard,
} from './connect-oauth-forms.tsx'
import {
	connectOauthHeaderDescription,
	connectOauthHeaderTitle,
	renderCallbackPending,
	renderChooser,
	renderIncompleteConfig,
	renderStatusCallout,
	wouldReplaceDifferentApp,
} from './connect-oauth-sections.tsx'
import {
	type ConnectOauthChooserOption,
	type ConnectOauthStatusTone,
	type ConnectOauthStep,
	buildConnectOauthAuthorizeUrl,
	buildConnectOauthIntegrationLookupHref,
	connectOauthHeaderCss,
	connectOauthEyebrowCss,
	connectOauthPageCss,
	exchangeConnectOauthCode,
	getConnectOauthRedirectUri,
	getConnectOauthStateKey,
	normalizeConnectHref,
	persistConnectOauthConfig,
	readConnectOauthCallback,
	readConnectOauthQueryConfig,
	readStoredConnectOauthConfig,
	redirectToLoginOn401,
	saveConnectOauthApp,
	saveConnectOauthSecret,
	validateConnectOauthState,
} from './connect-oauth-shared.ts'
import {
	type ConnectOauthConfig,
	type ConnectOauthHostApprovalLink,
	type ConnectOauthNextSteps,
	type ConnectOauthQueryConfig,
	type StoredIntegrationConfig,
	formatConnectOauthCaughtError,
	formatMissingSetupFields,
	mergeConnectOauthConfig,
	parseConnectOauthNextSteps,
	parseHostApprovalLinks,
	summarizeStoredSetupState,
	toStoredIntegrationConfig,
} from './connect-oauth-config.ts'

export { connectOauthRouteLoader } from './connect-oauth-shared.ts'

export function ConnectOauthRoute(handle: Handle) {
	// The real status arrives once the query config and any stored/built-in
	// provider config resolve; starting on "Ready to connect." flashed a
	// misleading state on slow connections. Provider visits resolve during
	// render from SSR-embedded / SPA-preloaded loader data, so this fallback
	// only shows on callback returns and loader-failure refetches.
	let statusMessage = 'Loading provider configuration…'
	let statusTone: ConnectOauthStatusTone = 'info'
	let currentStep: ConnectOauthStep = 'setup'
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
	let chooserOptions: Array<ConnectOauthChooserOption> = []
	let chooserFilter = ''
	let requestedProvider: string | null = null
	/**
	 * Scope checkboxes stay on this list while the user unchecks. BYO has no
	 * operator menu, so using live `config.scopes` as the menu would delete
	 * unchecked items (and hide the picker if every box is cleared).
	 */
	let offeredScopeMenu: Array<string> = []
	let nextSteps: ConnectOauthNextSteps | null = null
	let approvingAllHosts = false
	let submitting = false
	let initialLoadStarted = false
	let routeDataApplied = false
	/**
	 * Normalized pathname+search the current resolution state belongs to.
	 * SPA navigations to a different connect URL (another provider, a
	 * platform lane switch) reset and re-resolve instead of keeping the
	 * previous provider's config on screen.
	 */
	let resolvedHref: string | null = null
	/** Server-computed redirect URI so SSR renders the card `window` builds. */
	let ssrRedirectUri: string | null = null
	let clientIdInput = ''
	let clientSecretInput = ''
	let hasStoredClientId = false
	let hasStoredClientSecret = false
	let revealStoredClientSecretField = false

	const resetResolutionState = () => {
		routeDataApplied = false
		initialLoadStarted = false
		resolvedHref = null
		config = null
		existingIntegrationConfig = null
		existingConnection = null
		builtInAvailable = false
		hasStoredClientSecret = false
		hasConfigError = false
		replaceConfirmed = false
		renameInput = ''
		chooserOptions = []
		chooserFilter = ''
		requestedProvider = null
		offeredScopeMenu = []
		hostApprovalLinks = []
		nextSteps = null
		accessTokenSaved = false
		refreshTokenSaved = false
		currentStep = 'setup'
		statusMessage = 'Loading provider configuration…'
		statusTone = 'info'
	}

	const update = () => handle.update()

	const setStatus = (
		message: string,
		tone: ConnectOauthStatusTone = 'info',
	) => {
		statusMessage = message
		statusTone = tone
		update()
	}

	const setStep = (step: ConnectOauthStep) => {
		currentStep = step
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

	const readExistingIntegrationConfig = async (
		queryConfig: ConnectOauthQueryConfig,
	): Promise<StoredIntegrationConfig | null> => {
		const lookupSearch =
			typeof window !== 'undefined'
				? new URLSearchParams(window.location.search)
				: new URLSearchParams()
		const response = await fetch(
			buildConnectOauthIntegrationLookupHref(
				queryConfig.providerKey,
				lookupSearch,
			),
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
		hasStoredClientSecret = payload.hasStoredClientSecret === true
		if (!payload.integration) return null
		return toStoredIntegrationConfig(payload.integration)
	}

	const applySetupState = (nextConfig: ConnectOauthConfig) => {
		clientIdInput = nextConfig.clientId
		clientSecretInput = ''
		hasStoredClientId = Boolean(nextConfig.clientId.trim())
		hasStoredClientSecret =
			Boolean(nextConfig.clientSecretSecretName) && hasStoredClientSecret
		revealStoredClientSecretField = false
		const setupStatus = summarizeStoredSetupState({
			flow: nextConfig.flow,
			clientId: nextConfig.clientId,
			hasStoredClientSecret,
			platform: Boolean(nextConfig.platformAppSlug),
		})
		offeredScopeMenu = resolveOauthScopeMenu({
			allowedScopes: nextConfig.platformAllowedScopes,
			selectedScopes: nextConfig.scopes,
		})
		if (setupStatus.isReady) {
			statusMessage = 'Ready to connect.'
			statusTone = 'info'
			currentStep = 'connect'
			return
		}
		const missingDetails = formatMissingSetupFields(setupStatus.missingFields)
		statusMessage = existingIntegrationConfig
			? `Loaded your existing integration config. ${missingDetails}`
			: missingDetails
		statusTone = 'info'
		currentStep = 'setup'
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
				const secretResult = await saveConnectOauthSecret(
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
			const appResult = await saveConnectOauthApp(nextConfig)
			if (!appResult.ok) {
				setStatus(appResult.error, 'error')
				return
			}
			config = { ...nextConfig, clientId: appResult.clientId }
			persistConnectOauthConfig(config)
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

	const toggleRequestedScope = (scope: string) => {
		if (!config) return
		const menu = resolveOauthScopeMenu({
			allowedScopes:
				config.platformAllowedScopes.length > 0
					? config.platformAllowedScopes
					: offeredScopeMenu,
			selectedScopes: config.scopes,
		})
		if (!menu.includes(scope)) return
		const selected = new Set(config.scopes)
		if (selected.has(scope)) selected.delete(scope)
		else selected.add(scope)
		config = {
			...config,
			scopes: uniqueOauthScopes(menu.filter((entry) => selected.has(entry))),
		}
		persistConnectOauthConfig(config)
		update()
	}

	const handleConnect = async () => {
		if (!config || submitting) return
		submitting = true
		update()
		try {
			const url = await buildConnectOauthAuthorizeUrl({
				config,
				hasConfigError,
				redirectUri: getConnectOauthRedirectUri(ssrRedirectUri),
			})
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
			const callback = readConnectOauthCallback()
			if (callback.kind !== 'none') {
				window.history.replaceState(
					null,
					'',
					getConnectOauthRedirectUri(ssrRedirectUri),
				)
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
			const valid = validateConnectOauthState(
				getConnectOauthStateKey(config.providerKey),
				callback.state,
			)
			if (!valid) {
				setStatus('State mismatch. Restart the OAuth flow.', 'error')
				setStep('connect')
				return
			}
			const exchange = await exchangeConnectOauthCode(
				config,
				callback.code,
				getConnectOauthRedirectUri(ssrRedirectUri),
			)
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
			hostApprovalLinks = parseHostApprovalLinks(payload.hostApprovalLinks)
			nextSteps = parseConnectOauthNextSteps(payload.nextSteps)
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

	const applyRouteLoaderData = (currentHref: string) => {
		if (routeDataApplied) return
		const url = new URL(currentHref, 'https://kody.local')
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'connectOauth',
			currentHref,
		)
		if (!routeData) return
		routeDataApplied = true
		ssrRedirectUri = routeData.redirectUri ?? null
		builtInAvailable = routeData.builtInAvailable ?? false
		existingConnection = routeData.existingConnection ?? null
		chooserOptions = routeData.chooser?.options ?? []
		if (url.searchParams.get('code') || url.searchParams.get('error')) {
			return
		}
		requestedProvider =
			url.searchParams.get('provider')?.trim() || routeData.provider
		if (!requestedProvider) {
			statusMessage = 'Choose a service to connect.'
			statusTone = 'info'
			return
		}
		const parsed = readConnectOauthQueryConfig(url)
		if (!parsed.ok) {
			hasConfigError = true
			statusMessage = parsed.error
			statusTone = 'error'
			return
		}
		const storedIntegration =
			routeData.provider === parsed.value.providerKey && routeData.integration
				? toStoredIntegrationConfig(routeData.integration)
				: null
		existingIntegrationConfig = storedIntegration
		const nextConfig = mergeConnectOauthConfig({
			queryConfig: parsed.value,
			storedIntegration,
		})
		if (!nextConfig) {
			hasConfigError = true
			statusMessage = 'Missing required OAuth configuration parameters.'
			statusTone = 'error'
			return
		}
		config = nextConfig
		hasStoredClientSecret = routeData.hasStoredClientSecret === true
		applySetupState(nextConfig)
	}

	const loadChooserFallback = async (hrefStillCurrent: () => boolean) => {
		const response = await fetch(
			'/account/integrations.json?connectChooser=1',
			{
				headers: { Accept: 'application/json' },
				credentials: 'include',
			},
		)
		if (!hrefStillCurrent()) return false
		if (redirectToLoginOn401(response)) return false
		const payload = (await response.json().catch(() => null)) as {
			ok?: boolean
			chooser?: ConnectOauthLoaderData['chooser']
		} | null
		if (!hrefStillCurrent()) return false
		chooserOptions =
			response.ok && payload?.ok === true
				? (payload.chooser?.options ?? [])
				: []
		return true
	}

	const initializeVisit = async () => {
		if (initialLoadStarted) return
		initialLoadStarted = true
		const taskHref = resolvedHref
		const hrefStillCurrent = () =>
			taskHref === normalizeConnectHref(readCurrentRouterHref(handle))
		try {
			const callback = readConnectOauthCallback()
			if (callback.kind === 'success' || callback.kind === 'error') {
				const storedConfig = readStoredConnectOauthConfig()
				let nextConfig = storedConfig
				if (!nextConfig) {
					const parsed = readConnectOauthQueryConfig(
						new URL(window.location.href),
					)
					nextConfig = parsed.ok
						? mergeConnectOauthConfig({
								queryConfig: parsed.value,
								storedIntegration: await readExistingIntegrationConfig(
									parsed.value,
								),
							})
						: null
				}
				if (!nextConfig) {
					if (!hrefStillCurrent()) return
					if (chooserOptions.length === 0) {
						const loaded = await loadChooserFallback(hrefStillCurrent)
						if (!hrefStillCurrent() || !loaded) return
					}
					hasConfigError = true
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
			if (!config && !hasConfigError) {
				const visitUrl = new URL(window.location.href)
				if (!visitUrl.searchParams.get('provider')?.trim()) {
					if (chooserOptions.length === 0) {
						const loaded = await loadChooserFallback(hrefStillCurrent)
						if (!hrefStillCurrent() || !loaded) return
						update()
					}
					return
				}
				const parsed = readConnectOauthQueryConfig(visitUrl)
				if (!parsed.ok) {
					hasConfigError = true
					requestedProvider = visitUrl.searchParams.get('provider')
					setStatus(parsed.error, 'error')
					return
				}
				const existingIntegration = await readExistingIntegrationConfig(
					parsed.value,
				)
				if (!hrefStillCurrent()) return
				existingIntegrationConfig = existingIntegration
				const nextConfig = mergeConnectOauthConfig({
					queryConfig: parsed.value,
					storedIntegration: existingIntegration,
				})
				if (!nextConfig) {
					hasConfigError = true
					requestedProvider = parsed.value.provider
					setStatus('Missing required OAuth configuration parameters.', 'error')
					return
				}
				config = nextConfig
				applySetupState(nextConfig)
				update()
			}
		} catch (error) {
			// Initial integration reads use fetch(); a transient network
			// failure must not escape queueTask as unhandledrejection.
			setStatus(
				formatConnectOauthCaughtError(
					error,
					'Network error. Please try again.',
				),
				'error',
			)
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const normalizedHref = normalizeConnectHref(currentHref)
		if (
			resolvedHref !== null &&
			resolvedHref !== normalizedHref &&
			!connectOauthHandled
		) {
			resetResolutionState()
		}
		if (resolvedHref === null) {
			resolvedHref = normalizedHref
		}
		applyRouteLoaderData(currentHref)
		if (!initialLoadStarted && typeof document !== 'undefined') {
			handle.queueTask(initializeVisit)
		}
		const headerInput = {
			config,
			requestedProvider,
			hasConfigError,
			statusTone,
			statusMessage,
			currentStep,
			href: currentHref,
		}
		const description = connectOauthHeaderDescription(headerInput)
		const title = connectOauthHeaderTitle(headerInput)
		if (!config) {
			return (
				<section mix={css(connectOauthPageCss)}>
					<header mix={css(connectOauthHeaderCss)}>
						<span mix={css(connectOauthEyebrowCss)}>Connect an account</span>
						<h1 mix={css(pageTitleCss)}>{title}</h1>
						{description ? (
							<p mix={css(pageDescriptionCss)}>{description}</p>
						) : null}
					</header>
					{renderStatusCallout({ statusTone, statusMessage, currentStep })}
					{requestedProvider && hasConfigError
						? renderIncompleteConfig(requestedProvider)
						: isConnectOauthCallbackUrl(
									new URL(currentHref, 'https://kody.local'),
							  ) && statusTone !== 'error'
							? renderCallbackPending()
							: renderChooser({
									chooserOptions,
									chooserFilter,
									onFilterChange: (value) => {
										chooserFilter = value
										update()
									},
								})}
				</section>
			)
		}
		const currentConfig = config
		return (
			<section mix={css(connectOauthPageCss)}>
				<header mix={css(connectOauthHeaderCss)}>
					<ProviderMark
						providerKey={currentConfig.providerKey}
						label={currentConfig.provider}
						logoPath={currentConfig.platformLogoPath ?? currentConfig.logoPath}
						autoLogoPath={currentConfig.autoLogoPath}
						host={currentConfig.authorizeHost}
					/>
					<span mix={css(connectOauthEyebrowCss)}>Connect an account</span>
					<h1 mix={css(pageTitleCss)}>{title}</h1>
					{description ? (
						<p mix={css(pageDescriptionCss)}>{description}</p>
					) : null}
				</header>
				{renderStatusCallout({ statusTone, statusMessage, currentStep })}
				{currentStep === 'setup'
					? renderRedirectUriCard({
							config: currentConfig,
							redirectUri: getConnectOauthRedirectUri(ssrRedirectUri),
						})
					: null}
				{currentStep === 'setup' ? (
					<ConnectOauthCredentialsForm
						config={currentConfig}
						existingIntegrationConfig={existingIntegrationConfig}
						hasStoredClientId={hasStoredClientId}
						hasStoredClientSecret={hasStoredClientSecret}
						revealStoredClientSecretField={revealStoredClientSecretField}
						clientIdInput={clientIdInput}
						clientSecretInput={clientSecretInput}
						submitting={submitting}
						onClientIdInput={(value) => {
							clientIdInput = value
							update()
						}}
						onClientSecretInput={(value) => {
							clientSecretInput = value
							update()
						}}
						onRevealStoredClientSecret={() => {
							revealStoredClientSecretField = true
							update()
						}}
						onSubmit={(event) => {
							void handleSetupSubmit(event)
						}}
					/>
				) : null}
				{currentStep === 'connect'
					? renderConnectStep({
							config: currentConfig,
							existingConnection,
							replaceConfirmed,
							renameInput,
							submitting,
							offeredScopeMenu,
							onConfirmReplace: () => {
								replaceConfirmed = true
								update()
							},
							onRenameInput: (value) => {
								renameInput = value
								update()
							},
							onConnect: () => {
								void handleConnect()
							},
							onToggleScope: toggleRequestedScope,
							wouldReplace: wouldReplaceDifferentApp({
								config: currentConfig,
								existingConnection,
							}),
						})
					: null}
				{currentStep === 'success'
					? renderSuccessCard({
							config: currentConfig,
							hostApprovalLinks,
							nextSteps,
							approvingAllHosts,
							onApproveAllHosts: () => {
								void approveAllHostApprovals()
							},
						})
					: null}
				{currentStep === 'success'
					? renderSuccessAdvancedDetails({
							config: currentConfig,
							accessTokenSaved,
							refreshTokenSaved,
							hostApprovalLinks,
						})
					: renderAdvancedDetails({
							config: currentConfig,
							builtInAvailable,
							existingIntegrationConfig,
						})}
			</section>
		)
	}
}
