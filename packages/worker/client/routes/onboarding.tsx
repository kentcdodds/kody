import { type Handle, css, ref } from 'remix/ui'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
} from '#universal/loader-data.ts'
import {
	closeOnboardingMcpOAuthPopupIfOpened,
	listenForOnboardingMcpOAuthDone,
} from '#client/mcp-oauth-popup.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import { landingArtAttrs } from '#universal/landing-images.ts'
import { routes } from '#universal/routes.ts'
import {
	firstInstalledOnboardingExampleName,
	hasInstalledOnboardingExample,
	onboardingExampleInstallFingerprint,
	selectOnboardingExampleListings,
	selectOnboardingServiceStarterListings,
} from '#universal/onboarding-examples.ts'
import {
	customOnboardingMcpFingerprint,
	featuredOnboardingMcpFingerprint,
	firstConnectedOnboardingWorkspaceLabel,
	formatOnboardingFeaturedMcpChoice,
	hasConnectedOnboardingWorkspaceMcp,
	hasPendingOnboardingCustomMcpAuth,
	hasPendingOnboardingFeaturedMcpAuth,
	resolveOnboardingMcpOAuthBanner,
} from '#universal/onboarding-mcp-chooser.ts'
import {
	fetchOnboardingPayload,
	onboardingApiPath,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import { OnboardingDiyCard } from '#client/routes/onboarding-diy-card.tsx'
import {
	isOnboardingChecklistItemDone,
	OnboardingChecklistCard,
	shouldShowOnboardingChecklist,
} from '#client/routes/onboarding-checklist.tsx'
import { OnboardingMcpClientTabs } from '#client/routes/onboarding-mcp-client-tabs.tsx'
import { OnboardingCustomMcpCard } from '#client/routes/onboarding-custom-mcp-card.tsx'
import { OnboardingMcpChooserCard } from '#client/routes/onboarding-mcp-chooser-card.tsx'
import { OnboardingExampleCard } from '#client/routes/onboarding-example-card.tsx'
import { OnboardingPersistCard } from '#client/routes/onboarding-persist-card.tsx'
import { OnboardingFactoryCard } from '#client/routes/onboarding-factory-card.tsx'
import { createOnboardingNextConfirmation } from '#client/routes/onboarding-next-confirmation.ts'
import { OnboardingPackageNextSteps } from '#client/routes/onboarding-package-next-steps.tsx'
import { OnboardingStarterCard } from '#client/routes/onboarding-starter-card.tsx'
import { ProviderIcon } from '#client/provider-icons.tsx'
import {
	onboardingPath,
	resolveOnboardingPendingVerificationPath,
} from '#client/routes/onboarding-redirect.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	inlineSpinnerCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Onboarding wizard: shirt-pattern head, three-step stepper (Connect your
 * agent · Give Kody Access · Try it, then persist), one surface panel at a
 * time with hand-tilted mascot art, and the BYOK argument folded behind a
 * disclosure. Server state (prompts, MCP URL, featured MCP servers,
 * hasMcpClient / OAuth polling) stays in the route state.
 *
 * Step 2 is "give Kody access to your stuff." Official remote MCP is the
 * easy login path; Connect also forks the matching `@kody/*-mcp` helper
 * into the person's account. Official `@kody/*` listings are catalog and
 * fork source — person accounts run the owned copy, not the platform
 * package. Ranked exits: featured official MCP, custom MCP, Advanced
 * (provider guides + BYOK), Just-try-Kody, then skip. Step 3 is the
 * permanence lesson: one ad hoc execute, then persist that working code.
 */

type OnboardingStep = 1 | 2 | 3

const onboardingSteps = [
	{ number: 1, label: 'Connect your agent', hash: 'connect-agent' },
	{ number: 2, label: 'Give Kody Access', hash: 'connect-mcp' },
	{ number: 3, label: 'Try it, then persist', hash: 'first-build' },
] as const satisfies ReadonlyArray<{
	number: OnboardingStep
	label: string
	hash: string
}>

/** Older hashes from the email/memory, example-fork, and OAuth-lead steps. */
const legacyOnboardingStepHashes: Record<string, OnboardingStep> = {
	'first-win': 2,
	'quick-example': 3,
	'connect-services': 2,
	'starter-packages': 3,
}

function isOnboardingPath(href: string) {
	return new URL(href, 'http://localhost').pathname === onboardingPath
}

function readOwnedExampleKodyId(
	listings: Array<OnboardingFeaturedListing>,
): string {
	const owned = listings.find((listing) => listing.viewerInstall != null)
	if (!owned?.viewerInstall) return 'my-package'
	const separatorIndex = owned.viewerInstall.targetName.lastIndexOf('/')
	return separatorIndex >= 0
		? owned.viewerInstall.targetName.slice(separatorIndex + 1)
		: owned.kodyId
}

function readStepFromHref(href: string): OnboardingStep | null {
	const hash = new URL(href, 'http://localhost').hash.slice(1)
	return (
		onboardingSteps.find((candidate) => candidate.hash === hash)?.number ??
		legacyOnboardingStepHashes[hash] ??
		null
	)
}

function readOnboardingRedirectTo(handle: Handle) {
	return normalizeRedirectTo(
		new URLSearchParams(readRouterSearch(handle)).get('redirectTo'),
	)
}

export async function onboardingRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const redirectTo = normalizeRedirectTo(url.searchParams.get('redirectTo'))
	const response = await fetch(onboardingApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	const payload = await readJson<OnboardingPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load onboarding.')
	}
	if (payload.loggedIn && !payload.emailVerified) {
		return routeLoaderRedirect(
			resolveOnboardingPendingVerificationPath(redirectTo),
		)
	}
	return { onboarding: payload }
}

export function OnboardingRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let message: string | null = null
	let loggedIn = false
	let username: string | null = null
	let mcpServerUrl = ''
	let setupPrompt = ''
	let persistPrompt = ''
	let hasMcpClient = false
	let hasStep2Win = false
	let hasPersistedPackage = false
	let persistedPackageKodyId: string | null = null
	let featuredListings: Array<OnboardingFeaturedListing> = []
	let exampleListings: Array<OnboardingFeaturedListing> = []
	let serviceStarterListings: Array<OnboardingFeaturedListing> = []
	let featuredMcpServers: Array<OnboardingFeaturedMcpServer> = []
	let customMcpServers: Array<OnboardingCustomMcpServer> = []
	let checklist: OnboardingChecklistLoaderData | null = null
	let checklistHidden = false
	let activeStep: OnboardingStep = 1
	let initializedStep = false
	let appliedInitialHash = false
	let awaitingMcpConnection = false
	let oauthReturnError: string | null = null
	let oauthReturnSucceeded = false
	// Panel entrances only play for real step changes, never on the first
	// paint — the page-open choreography belongs to the head's data-rise.
	let panelAnimationArmed = false
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: OnboardingPayload) {
		const wasConnected = hasMcpClient
		loggedIn = payload.loggedIn
		username = payload.username
		mcpServerUrl = payload.mcpServerUrl
		setupPrompt = payload.setupPrompt
		persistPrompt = payload.persistPrompt
		hasMcpClient = payload.hasMcpClient
		featuredListings = payload.featuredListings ?? []
		exampleListings = selectOnboardingExampleListings(featuredListings)
		serviceStarterListings =
			selectOnboardingServiceStarterListings(featuredListings)
		featuredMcpServers = payload.featuredMcpServers ?? []
		customMcpServers = payload.customMcpServers ?? []
		const workspaceConnected = hasConnectedOnboardingWorkspaceMcp({
			featuredMcpServers,
			customMcpServers,
		})
		hasStep2Win =
			workspaceConnected || hasInstalledOnboardingExample(exampleListings)
		if (workspaceConnected) {
			awaitingMcpConnection = false
			oauthReturnError = null
			oauthReturnSucceeded = true
		}
		checklist = payload.checklist
		hasPersistedPackage = isOnboardingChecklistItemDone(
			payload.checklist,
			'install-starter',
		)
		persistedPackageKodyId = payload.persistedPackageKodyId ?? null
		if (payload.checklist?.dismissed) checklistHidden = true
		status = 'ready'
		message = null
		if (!initializedStep) {
			activeStep = hasStep2Win ? 3 : payload.hasMcpClient ? 2 : 1
			initializedStep = true
		} else if (!wasConnected && payload.hasMcpClient && !hasStep2Win) {
			panelAnimationArmed = true
			activeStep = 2
			updateStepHash(2)
			scrollToNav('onboarding-steps-nav')
		}
		// Stay on Step 2 when access or an example finishes so the
		// Connected/Installed state is visible; wizard nav advances.
	}

	/**
	 * Advancing (click or auto) scrolls back to the relevant steps nav so
	 * people always see where they are in the flow.
	 */
	function scrollToNav(id: string) {
		if (typeof document === 'undefined') return
		requestAnimationFrame(() => {
			document.getElementById(id)?.scrollIntoView({
				behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
					? 'auto'
					: 'smooth',
				block: 'start',
			})
		})
	}

	function updateStepHash(step: OnboardingStep) {
		if (typeof window === 'undefined') return
		const stepDefinition = onboardingSteps.find(
			(candidate) => candidate.number === step,
		)
		if (!stepDefinition) return
		const url = new URL(window.location.href)
		url.hash = stepDefinition.hash
		window.history.replaceState(window.history.state, '', url)
	}

	function selectStep(step: OnboardingStep) {
		panelAnimationArmed = true
		activeStep = step
		updateStepHash(step)
		scrollToNav('onboarding-steps-nav')
		void handle.update().then((signal) => {
			if (signal.aborted) return
			const stepDefinition = onboardingSteps.find(
				(candidate) => candidate.number === step,
			)
			if (!stepDefinition) return
			// The nav scroll owns the viewport position; focus must not yank
			// it back down to the panel heading.
			document
				.getElementById(stepDefinition.hash)
				?.querySelector('h2')
				?.focus({ preventScroll: true })
		})
	}

	async function refreshOnboardingAfterInstall() {
		try {
			const payload = await fetchOnboardingPayload(handle.signal)
			if (handle.signal.aborted || !payload) return
			applyPayload(payload)
			handle.update()
		} catch {
			// Install already succeeded in the card; the next poll retries.
		}
	}

	/**
	 * Prototype's `panel-enter` + `art-settle`: the fresh panel slides up
	 * while the mascot settles into its hand-placed tilt. WAAPI instead of a
	 * CSS class so it is enhance-only by construction and never replays on
	 * hydration.
	 */
	function panelEntrance() {
		return ref((node: Element) => {
			if (!panelAnimationArmed) return
			if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
			node.animate(
				[
					{ opacity: 0, translate: '0 12px' },
					{ opacity: 1, translate: '0 0' },
				],
				{ duration: 360, easing: transitions.easeOutValue },
			)
			const art = node.querySelector('[data-panel-art]')
			if (art instanceof HTMLElement) {
				const tilt = art.style.getPropertyValue('--tilt') || '0deg'
				art.animate(
					[
						{ opacity: 0, rotate: '0deg', scale: '0.92' },
						{ opacity: 1, rotate: tilt, scale: '1' },
					],
					{ duration: 560, easing: transitions.easeOutValue },
				)
			}
		})
	}

	async function loadOnboarding(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		const redirectTo = readOnboardingRedirectTo(handle)
		try {
			const response = await fetch(onboardingApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			const payload = await readJson<OnboardingPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load onboarding.')
			}
			if (payload.loggedIn && !payload.emailVerified) {
				window.location.assign(
					resolveOnboardingPendingVerificationPath(redirectTo),
				)
				return
			}
			applyPayload(payload)
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load onboarding.'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	// Users typically keep this page open while their MCP client runs OAuth,
	// a Step 2 Notion/Linear authorize finishes, or Step 3 persist completes,
	// so poll the same JSON endpoint until those signals land and collapse
	// completed steps without a manual refresh.
	//
	// The interval must stay clear of 5000ms: workerd's HTTP server closes
	// idle keep-alive connections after exactly 5s (kj pipeline timeout), so
	// a 5s poll makes every request race the close. wrangler >= 4.114 turns
	// that race's "Network connection lost" ProxyWorker error into a fatal
	// dev-server exit (cloudflare/workers-sdk#14926). Polling faster than 5s
	// keeps the connection warm so the race never happens.
	const onboardingProgressPollIntervalMs = 4000
	let pollIntervalId: ReturnType<typeof setInterval> | undefined
	let pollInFlight = false

	async function pollOnboardingProgress() {
		if (pollInFlight || status !== 'ready' || !loggedIn) return
		// Stop only when the agent is connected, featured MCP auth is idle,
		// and persist has landed with a kody id. install-starter can flip on
		// the same tick that loadPersistedPackageKodyId fails open to null,
		// so keep polling until the id arrives.
		if (
			hasMcpClient &&
			!hasPendingOnboardingFeaturedMcpAuth(featuredMcpServers) &&
			!hasPendingOnboardingCustomMcpAuth(customMcpServers) &&
			hasPersistedPackage &&
			persistedPackageKodyId != null
		) {
			return
		}
		if (document.hidden) return
		if (!isOnboardingPath(readCurrentRouterHref(handle))) return
		pollInFlight = true
		try {
			const payload = await fetchOnboardingPayload(handle.signal)
			if (handle.signal.aborted || !payload) return
			const nextServers = payload.featuredMcpServers ?? []
			const nextCustomServers = payload.customMcpServers ?? []
			const nextListings = payload.featuredListings ?? []
			const nextHasPersistedPackage = isOnboardingChecklistItemDone(
				payload.checklist,
				'install-starter',
			)
			if (
				payload.hasMcpClient === hasMcpClient &&
				featuredOnboardingMcpFingerprint(nextServers) ===
					featuredOnboardingMcpFingerprint(featuredMcpServers) &&
				customOnboardingMcpFingerprint(nextCustomServers) ===
					customOnboardingMcpFingerprint(customMcpServers) &&
				onboardingExampleInstallFingerprint(nextListings) ===
					onboardingExampleInstallFingerprint(featuredListings) &&
				nextHasPersistedPackage === hasPersistedPackage &&
				payload.persistedPackageKodyId === persistedPackageKodyId
			) {
				return
			}
			applyPayload(payload)
			handle.update()
		} catch {
			// Transient poll failures are fine; the next tick retries.
		} finally {
			pollInFlight = false
		}
	}

	if (typeof document !== 'undefined') {
		if (closeOnboardingMcpOAuthPopupIfOpened()) {
			// This tab was the authorize popup. The opener stays on the wizard.
		}
		pollIntervalId = setInterval(
			pollOnboardingProgress,
			onboardingProgressPollIntervalMs,
		)
		handle.signal.addEventListener('abort', () => clearInterval(pollIntervalId))
		window.addEventListener('hashchange', handleHashChange)
		handle.signal.addEventListener('abort', () =>
			window.removeEventListener('hashchange', handleHashChange),
		)
		listenForOnboardingMcpOAuthDone((outcome) => {
			if (outcome.auth === 'error' && outcome.reason) {
				oauthReturnError = outcome.reason
				oauthReturnSucceeded = false
				awaitingMcpConnection = false
				handle.update()
			} else if (outcome.auth === 'success') {
				oauthReturnError = null
				oauthReturnSucceeded = true
			}
			void refreshOnboardingAfterInstall()
		}, handle.signal)
	}

	function handleHashChange() {
		const step = readStepFromHref(window.location.href)
		if (!step) return
		panelAnimationArmed = true
		activeStep = step
		handle.update()
	}

	function applyRouteLoaderData(href: string) {
		if (!isOnboardingPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'onboarding', href)
		if (!routeData) return false
		if (routeData.loggedIn && !routeData.emailVerified) {
			window.location.assign(
				resolveOnboardingPendingVerificationPath(
					readOnboardingRedirectTo(handle),
				),
			)
			return true
		}
		applyPayload(routeData)
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadOnboarding)
		}
		if (
			status === 'ready' &&
			typeof document !== 'undefined' &&
			!appliedInitialHash
		) {
			appliedInitialHash = true
			handle.queueTask(() => {
				const step = readStepFromHref(window.location.href)
				if (!step || step === activeStep) return
				activeStep = step
				handle.update()
			})
		}

		const workspaceLabel = firstConnectedOnboardingWorkspaceLabel({
			featuredMcpServers,
			customMcpServers,
		})
		const exampleName = firstInstalledOnboardingExampleName(exampleListings)
		const persistTargetLabel = workspaceLabel ?? exampleName

		return (
			<section mix={css(onboardCss)}>
				<header mix={css(onboardHeadCss)}>
					<h1 data-rise style={{ '--rise': '0' }}>
						Get started with <em>Kody</em>
					</h1>
					<p data-rise style={{ '--rise': '1' }}>
						Give your agent a personal software factory: connect any MCP-capable
						host, add {formatOnboardingFeaturedMcpChoice()}, then run an ad hoc
						request and persist it as a package you own. New here?{' '}
						<a
							href="/guides/what-is-kody"
							target="_blank"
							rel="noreferrer noopener"
							mix={css(headerGuideLinkCss)}
						>
							Read what Kody can do
						</a>{' '}
						first.
					</p>
					<p
						data-rise
						style={{ '--rise': '2' }}
						mix={css(discordInviteWrapCss)}
					>
						<a
							href={routes.discord.href()}
							mix={css(discordInviteLinkCss)}
							data-testid="onboarding-join-discord"
						>
							<ProviderIcon providerId="discord" size="1.1em" />
							Join the Discord
						</a>
					</p>
				</header>

				{status === 'loading' ? (
					<p mix={css(loadingCss)}>Loading onboarding…</p>
				) : null}
				{message ? (
					<p mix={css(errorMessageCss)} role="alert">
						{message}
					</p>
				) : null}

				{status === 'ready' ? (
					<>
						<nav
							id="onboarding-steps-nav"
							aria-label="Onboarding steps"
							mix={css(wizardStepsCss)}
						>
							{onboardingSteps.map((step) => {
								const isActive = activeStep === step.number
								const isComplete =
									(step.number === 1 && hasMcpClient) ||
									(step.number === 2 && hasStep2Win)
								return (
									<button
										key={step.number}
										type="button"
										aria-current={isActive ? 'step' : undefined}
										mix={[
											css(stepButtonCss),
											on('click', () => selectStep(step.number)),
										]}
									>
										<span data-wizard-num mix={css(stepNumberCss)}>
											{step.number}
										</span>
										<span>{step.label}</span>
										{isComplete ? (
											<span
												role="img"
												aria-label="Complete"
												mix={css(stepCheckCss)}
											>
												✓
											</span>
										) : null}
									</button>
								)
							})}
						</nav>

						{activeStep === 1 ? (
							<section
								id="connect-agent"
								aria-labelledby="connect-title"
								data-testid="onboarding-connect-agent"
								mix={[css(wizardPanelCss), panelEntrance()]}
							>
								<div mix={css(panelHeadCss)}>
									<div>
										<p mix={css(panelKickerCss)}>Step 1</p>
										<h2
											id="connect-title"
											tabIndex={-1}
											mix={css(panelTitleCss)}
										>
											Connect your agent
										</h2>
									</div>
									<img
										data-panel-art
										src="/images/kody-mcp-plug.webp"
										width={627}
										height={627}
										loading="lazy"
										alt="Kody plugging a cable into a warmly glowing port on a laptop"
										style={{ '--tilt': '2deg' }}
										mix={css(panelArtCss)}
									/>
								</div>
								<div
									mix={css(connectStatusCss)}
									role="status"
									aria-live="polite"
									data-connected={hasMcpClient ? 'true' : undefined}
								>
									{connectStatusContent({
										connected: hasMcpClient,
										connectedLabel: 'You are connected',
										waitingLabel: 'Waiting for your agent to connect…',
									})}
								</div>
								<OnboardingMcpClientTabs mcpServerUrl={mcpServerUrl} />
								<div
									mix={css(authNoteCss)}
									role="note"
									data-testid="onboarding-authenticate-callout"
								>
									<strong>Authenticate Kody before you continue</strong>
									<span>
										<strong>Cursor:</strong> after install, open the Cursor MCP
										list and click <strong>Authenticate</strong>.
									</span>
									<span>
										<strong>Claude Code:</strong> after install, enter{' '}
										<code>/mcp</code> → Kody → <strong>Authenticate</strong>.
									</span>
									<span>
										<strong>Grok.com:</strong> after adding the custom
										connector, complete OAuth when Grok prompts you.
									</span>
									<span>
										<strong>Grok CLI:</strong> after adding the server, OAuth
										opens on first use. In the TUI, <code>/mcps</code> then{' '}
										<strong>i</strong> authenticates.{' '}
										<code>grok mcp doctor kody</code> checks the connection.
									</span>
									<span>
										Approve the <strong>kody.codes</strong> OAuth window. This
										is the step that connects your agent to your factory.
									</span>
								</div>
								<WizardNavigation
									activeStep={activeStep}
									onSelectStep={selectStep}
									confirmUnconnectedNext={!hasMcpClient}
								/>
							</section>
						) : null}

						{activeStep === 2 ? (
							<section
								id="connect-mcp"
								aria-labelledby="connect-mcp-title"
								data-testid="onboarding-connect-mcp"
								mix={[css(wizardPanelCss), panelEntrance()]}
							>
								<div mix={css(panelHeadCss)}>
									<div>
										<p mix={css(panelKickerCss)}>Step 2</p>
										<h2
											id="connect-mcp-title"
											tabIndex={-1}
											mix={css(panelTitleCss)}
										>
											Give Kody Access
										</h2>
									</div>
									<img
										data-panel-art
										{...landingArtAttrs('kody-community-packages')}
										width={627}
										height={627}
										alt="Kody kneeling beside a stack of parcels, one open and glowing with a eucalyptus sprig"
										style={{ '--tilt': '1.5deg' }}
										mix={css(panelArtCss)}
									/>
								</div>
								<p mix={css(panelLedeCss)}>
									Give Kody access to your stuff. Official one-click login is
									the easy path: add {formatOnboardingFeaturedMcpChoice()} and
									authorize it. Connect also copies the matching official helper
									into your account. None of these? Add another server, or just
									try Kody without a third-party login.
								</p>
								<ul
									mix={css(starterGridCss)}
									data-testid="onboarding-mcp-chooser"
								>
									{featuredMcpServers.map((server) => (
										<OnboardingMcpChooserCard
											key={server.id}
											server={server}
											loggedIn={loggedIn}
											onChanged={() => {
												void refreshOnboardingAfterInstall()
											}}
											onAuthStarted={() => {
												awaitingMcpConnection = true
												handle.update()
											}}
										/>
									))}
								</ul>
								<Step2ConnectStatus
									waiting={
										awaitingMcpConnection ||
										hasPendingOnboardingFeaturedMcpAuth(featuredMcpServers) ||
										hasPendingOnboardingCustomMcpAuth(customMcpServers)
									}
									connected={hasConnectedOnboardingWorkspaceMcp({
										featuredMcpServers,
										customMcpServers,
									})}
									exampleInstalled={hasInstalledOnboardingExample(
										exampleListings,
									)}
									oauthError={resolveOnboardingMcpOAuthBanner({
										connected: hasConnectedOnboardingWorkspaceMcp({
											featuredMcpServers,
											customMcpServers,
										}),
										returnedSuccess: oauthReturnSucceeded,
										returnedError: oauthReturnError,
										urlError: readOnboardingMcpOAuthError(handle),
									})}
									onNext={() => selectStep(3)}
								/>
								<aside
									aria-label="How it works"
									mix={css(howItWorksCss)}
									data-testid="onboarding-how-it-works"
								>
									<p mix={css(howItWorksLabelCss)}>How it works</p>
									<p>
										Connect adds the official login, copies the matching helper
										into your account, and opens the provider authorize page.
										Approve access, then your agent can use those tools. You run
										the copy in your account — official <em>@kody</em> listings
										are a catalog, not something a person account invokes live.
									</p>
								</aside>
								<div
									mix={css(step2ExitCss)}
									data-testid="onboarding-none-of-these"
								>
									<p mix={css(step2ExitLabelCss)}>None of these?</p>
									<p mix={css(step2ExitLedeCss)}>
										Add any remote MCP server. Same easy authorize path — just
										not a vendor we featured.
									</p>
									<OnboardingCustomMcpCard
										servers={customMcpServers}
										loggedIn={loggedIn}
										onChanged={() => {
											void refreshOnboardingAfterInstall()
										}}
										onAuthStarted={() => {
											awaitingMcpConnection = true
											handle.update()
										}}
									/>
								</div>
								<div mix={css(step2ExitCss)} data-testid="onboarding-advanced">
									<p mix={css(step2ExitLabelCss)}>Advanced</p>
									<p mix={css(step2ExitLedeCss)}>
										No one-click login for that service? Follow a provider guide
										— GitHub and Google are the usual next ones — or bring your
										own keys after the first build.
									</p>
									<p mix={css(step2ExitLedeCss)}>
										<a href="/guides/github" mix={css(primaryLinkCss)}>
											Connect GitHub
										</a>
										{' · '}
										<a href="/guides/google" mix={css(primaryLinkCss)}>
											Connect Google
										</a>
										{' · '}
										<a href="/account/secrets/new" mix={css(primaryLinkCss)}>
											Account → Secrets
										</a>
										{' · '}
										<a href="#byok" mix={css(primaryLinkCss)}>
											Why bring your own keys?
										</a>
									</p>
								</div>
								{exampleListings.length > 0 ? (
									<div
										mix={css(step2ExitCss)}
										data-testid="onboarding-just-try"
									>
										<p mix={css(step2ExitLabelCss)}>Just try Kody</p>
										<p mix={css(step2ExitLedeCss)}>
											No third-party login. Install an example, then persist it
											as a package you own.
										</p>
										<ul
											mix={css(starterGridCss)}
											data-testid="onboarding-example-packages"
										>
											{exampleListings.map((listing) => (
												<OnboardingExampleCard
													key={listing.id}
													listing={listing}
													loggedIn={loggedIn}
													username={username}
													onInstalled={() => {
														void refreshOnboardingAfterInstall()
													}}
												/>
											))}
										</ul>
									</div>
								) : null}
								<WizardNavigation
									activeStep={activeStep}
									onSelectStep={selectStep}
									confirmUnconnectedNext={!hasStep2Win}
									skipLabel="Skip for now"
									onSkip={() => selectStep(3)}
								/>
							</section>
						) : null}

						{activeStep === 3 ? (
							<section
								id="first-build"
								aria-labelledby="first-build-title"
								data-testid="onboarding-first-build"
								mix={[css(wizardPanelCss), panelEntrance()]}
							>
								<div mix={css(panelHeadCss)}>
									<div>
										<p mix={css(panelKickerCss)}>Step 3</p>
										<h2
											id="first-build-title"
											tabIndex={-1}
											mix={css(panelTitleCss)}
										>
											Try it, then persist
										</h2>
									</div>
									<img
										data-panel-art
										{...landingArtAttrs('kody-greeting')}
										width={627}
										height={627}
										alt="Kody waving beside a warm envelope"
										style={{ '--tilt': '-1.5deg' }}
										mix={css(panelArtCss)}
									/>
								</div>
								<p mix={css(panelLedeCss)}>
									This is the permanence lesson: run one useful ad hoc request
									{persistTargetLabel ? ` against ${persistTargetLabel}` : ''},
									then save that working code as a package you own.
								</p>
								<OnboardingPersistCard
									persistPrompt={persistPrompt}
									connectedServerLabel={workspaceLabel}
									installedExampleName={exampleName}
								/>
								{hasPersistedPackage ? (
									<>
										<p
											mix={css(quickExampleDoneCss)}
											data-testid="onboarding-first-build-done"
										>
											Done — you have a package in your account. Keep editing
											it, or start another.
										</p>
										<OnboardingPackageNextSteps
											kodyId={
												persistedPackageKodyId ??
												readOwnedExampleKodyId(exampleListings)
											}
											source={persistedPackageKodyId ? 'persist' : 'fork'}
										/>
									</>
								) : null}
								<aside
									aria-label="How it works"
									mix={css(howItWorksCss)}
									data-testid="onboarding-persist-how-it-works"
								>
									<p mix={css(howItWorksLabelCss)}>How it works</p>
									<p>
										Paste the prompt into your connected agent. It runs one{' '}
										<em>execute</em> call, shows the result, then persists that
										working code with <em>package_save</em>. That owned package
										is the point of Kody.
									</p>
								</aside>
								<div mix={css(advancedSectionCss)}>
									<p mix={css(advancedLabelCss)}>
										More ways to connect
										<span mix={css(advancedBadgeCss)}>Advanced</span>
									</p>
									<p mix={css(advancedLedeCss)}>
										Featured starters stay available after the first build.
										Prefer your own keys for full control.
									</p>
									<ul mix={css(starterListCss)}>
										{serviceStarterListings.map((listing) => (
											<OnboardingStarterCard
												key={listing.id}
												listing={listing}
												loggedIn={loggedIn}
												variant="row"
											/>
										))}
										<OnboardingDiyCard
											setupPrompt={setupPrompt}
											variant="row"
										/>
									</ul>
									<p mix={css({ margin: '0.2rem 0 0' })}>
										<a
											href="/community"
											target="_blank"
											rel="noreferrer noopener"
											mix={css(primaryLinkCss)}
										>
											Browse all community packages
										</a>
									</p>
								</div>
								{shouldShowOnboardingChecklist(checklist) &&
								!checklistHidden ? (
									<OnboardingChecklistCard
										checklist={checklist!}
										onDismissed={() => {
											checklistHidden = true
											handle.update()
										}}
									/>
								) : null}
								<WizardNavigation
									activeStep={activeStep}
									onSelectStep={selectStep}
								/>
							</section>
						) : null}

						<OnboardingFactoryCard />

						{/* Outside the wizard panels on purpose: the prototype keeps the
					    BYOK disclosure visible on every step. */}
						{renderByokDetails()}

						{loggedIn ? null : (
							<p mix={css(authLinksCss)}>
								<a href="/signup" mix={css(primaryLinkCss)}>
									Sign up
								</a>
								{' · '}
								<a href="/login" mix={css(primaryLinkCss)}>
									Log in
								</a>
							</p>
						)}
					</>
				) : null}
			</section>
		)
	}
}

function WizardNavigation(
	handle: Handle<{
		activeStep: OnboardingStep
		onSelectStep: (step: OnboardingStep) => void
		/** Optional overrides when a step owns custom Back/Next behavior. */
		onBack?: () => void
		onNext?: () => void
		confirmUnconnectedNext?: boolean
		skipLabel?: string
		onSkip?: () => void
	}>,
) {
	const nextConfirmation = createOnboardingNextConfirmation(handle)
	return () => {
		const previousStep =
			handle.props.activeStep > 1
				? ((handle.props.activeStep - 1) as OnboardingStep)
				: null
		const nextStep =
			handle.props.activeStep < 3
				? ((handle.props.activeStep + 1) as OnboardingStep)
				: null
		const { onBack, onNext, onSkip, skipLabel } = handle.props
		const requiresConnectionConfirmation =
			handle.props.confirmUnconnectedNext === true
		const advance = () => {
			if (onNext) return onNext()
			if (nextStep) handle.props.onSelectStep(nextStep)
		}

		return (
			<footer mix={css(wizardNavCss)}>
				<button
					type="button"
					disabled={!onBack && previousStep == null}
					mix={[
						css(wizardBackButtonCss),
						on('click', () => {
							if (onBack) return onBack()
							if (previousStep) handle.props.onSelectStep(previousStep)
						}),
					]}
				>
					Back
				</button>
				<div mix={css(wizardNavTrailingCss)}>
					{onSkip && skipLabel ? (
						<button
							type="button"
							mix={[css(wizardSkipButtonCss), on('click', onSkip)]}
							data-testid="onboarding-wizard-skip"
						>
							{skipLabel}
						</button>
					) : null}
					<button
						type="button"
						disabled={!onNext && nextStep == null}
						mix={[
							css(wizardNextButtonCss),
							...nextConfirmation.getButtonMix({
								confirm: requiresConnectionConfirmation,
								onNext: advance,
							}),
						]}
						data-testid="onboarding-wizard-next"
					>
						{nextConfirmation.getLabel(requiresConnectionConfirmation)}
					</button>
				</div>
			</footer>
		)
	}
}

/**
 * BYOK aside, folded behind a disclosure per the live design: the full
 * argument is one click away, not a second page of reading. This is the
 * prototype's onboarding-specific framing ("Why there's no one-click
 * connect"); the integrations page keeps its own `byok-explainer` copy.
 */
function renderByokDetails() {
	return (
		<details id="byok" mix={css(byokDetailsCss)}>
			<summary mix={css(byokSummaryCss)}>Bring your own API keys</summary>
			{/*
			 * A `section` rather than a `div`: a generic element has no role, so
			 * the accessible name from `aria-labelledby` would be dropped.
			 */}
			<section mix={css(byokBodyCss)} aria-labelledby="byok-note-title">
				<img
					{...landingArtAttrs('kody-keys')}
					width={627}
					height={627}
					alt="Kody holding a golden key with both paws"
				/>
				<div>
					<h2 id="byok-note-title" mix={css(byokTitleCss)}>
						Why bring your own keys?
					</h2>
					<p mix={css(byokCopyCss)}>
						You create the connection yourself, and your agent walks you through
						it, so it is completely yours: your app, your scopes, no middleman.
					</p>
					<dl mix={css(byokCompareCss)}>
						<div>
							<dt>Typical apps</dt>
							<dd>
								<span>You</span> <span aria-hidden="true">→</span>{' '}
								<s>their shared app</s> <span aria-hidden="true">→</span>{' '}
								<span>GitHub</span>
							</dd>
						</div>
						<div>
							<dt>Kody</dt>
							<dd>
								<span>You</span> <span aria-hidden="true">→</span>{' '}
								<em>your own app</em> <span aria-hidden="true">→</span>{' '}
								<span>GitHub</span>
							</dd>
						</div>
					</dl>
					<ul mix={css(byokPointsCss)}>
						<li>
							<strong>Your keys, your scopes.</strong> You decide exactly what
							Kody can touch, and you can revoke it anytime.
						</li>
						<li>
							<strong>No middleman.</strong> Nothing sits between you and the
							provider: no shared app to trust or get breached.
						</li>
						<li>
							<strong>No fixed list.</strong> If it has an API, your Kody can
							learn to use it.
						</li>
					</ul>
				</div>
			</section>
		</details>
	)
}

/* ---------- styles ---------- */

const onboardCss = {
	maxWidth: '56rem',
	marginInline: 'auto',
	padding:
		'clamp(2.5rem, 6vw, 4.5rem) clamp(1.25rem, 4vw, 2.5rem) clamp(3rem, 7vw, 5rem)',
}

/* The shirt fabric welcomes you in, same whisper as the landing close. */
const onboardHeadCss = {
	position: 'relative' as const,
	/* See `pageHeadCss`: the fabric is a backdrop, so it paints under the head. */
	isolation: 'isolate' as const,
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: '-60% -12% -140%',
		background: `radial-gradient(ellipse 42% 58% at 68% 40%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
		maskImage: 'var(--kody-pattern)',
		maskPosition: 'center',
		maskSize: '340px',
		maskRepeat: 'repeat',
		WebkitMaskImage: 'var(--kody-pattern)',
		WebkitMaskPosition: 'center',
		WebkitMaskSize: '340px',
		WebkitMaskRepeat: 'repeat',
		pointerEvents: 'none' as const,
	},
	'& h1': {
		margin: 0,
		fontSize: 'clamp(2.2rem, 4.5vw, 3.2rem)',
		fontWeight: 760,
		letterSpacing: '-0.028em',
		lineHeight: 1.04,
	},
	'& h1 em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
	'& > p': {
		margin: '0.9rem 0 0',
		color: colors.textMuted,
		fontSize: '1.08rem',
		maxWidth: '52ch',
	},
}

const loadingCss = {
	margin: 'clamp(2.2rem, 5vw, 3.2rem) 0 0',
	color: colors.textMuted,
}

const errorMessageCss = {
	margin: 'clamp(2.2rem, 5vw, 3.2rem) 0 0',
	color: colors.error,
}

/* Stepper: the sequence is the page's spine — each step is a live button,
   with the number in a lantern of its own. */
const wizardStepsCss = {
	marginTop: 'clamp(2.2rem, 5vw, 3.2rem)',
	display: 'grid',
	gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
	gap: '0.8rem',
	'@media (max-width: 900px)': {
		gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	},
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		gap: '0.5rem',
	},
}

const stepButtonCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.7rem',
	font: `550 0.98rem/1.25 ${typography.fontFamilyBody}`,
	textAlign: 'left' as const,
	color: colors.textMuted,
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: '0.8rem 1rem',
	cursor: 'pointer',
	transition: `border-color 160ms ${transitions.easeOut}, color 160ms ${transitions.easeOut}, scale 160ms ${transitions.easeOut}`,
	[hoverMq]: {
		'&:hover': {
			borderColor: colors.primary,
			color: colors.text,
		},
		'&:hover [data-wizard-num]': {
			backgroundColor: `oklch(from ${colors.primary} l c h / 0.26)`,
		},
	},
	'&[aria-current="step"]': {
		borderColor: colors.primary,
		backgroundColor: `oklch(from ${colors.primary} l c h / 0.12)`,
		color: colors.primaryText,
		fontWeight: 680,
	},
	'&:active': { scale: '0.97' },
	'@media (prefers-reduced-motion: reduce)': {
		'&:active': { scale: 'none' },
	},
}

const stepNumberCss = {
	flex: 'none',
	display: 'grid',
	placeItems: 'center',
	width: '2rem',
	height: '2rem',
	borderRadius: '50%',
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.16)`,
	color: colors.primaryText,
	fontWeight: 760,
	transition: `background-color 160ms ${transitions.easeOut}`,
}

/* Feedback (checks appearing) borrows the waitlist's success-in pop. */
const wizardPopCss = {
	'@media (prefers-reduced-motion: no-preference)': {
		animation: `success-in 200ms ${transitions.easeOut} both`,
	},
}

const stepCheckCss = {
	marginLeft: 'auto',
	color: colors.primaryText,
	fontWeight: 760,
	...wizardPopCss,
}

/* One panel at a time: a card that holds the whole step. */
const wizardPanelCss = {
	marginTop: '1rem',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: 'clamp(1.4rem, 3.5vw, 2.2rem)',
	display: 'grid',
	gap: '1.15rem',
	/*
	 * Grid items floor at min-content, so one unbreakable child (a long URL, a
	 * wide code sample) would otherwise widen the whole panel and the page with
	 * it. Keep the column free to shrink and let the child wrap instead.
	 */
	minWidth: 0,
	'& > *': { minWidth: 0 },
}

const panelHeadCss = {
	display: 'flex',
	justifyContent: 'space-between',
	alignItems: 'center',
	gap: '1rem',
	'@media (max-width: 720px)': {
		flexDirection: 'column-reverse' as const,
		alignItems: 'flex-start',
	},
}

const panelKickerCss = {
	margin: '0 0 0.35rem',
	font: `700 0.78rem/1 ${typography.fontFamilyDisplay}`,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.09em',
	color: colors.primaryText,
}

const panelTitleCss = {
	margin: 0,
	fontSize: 'clamp(1.4rem, 2.4vw, 1.75rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	lineHeight: 1.15,
}

/* Placed by hand, not stamped by a grid. */
const panelArtCss = {
	flex: 'none',
	width: 'clamp(90px, 11vw, 130px)',
	height: 'auto',
	rotate: 'var(--tilt, 0deg)',
	margin: '-0.4rem 0 -1.4rem',
	'@media (max-width: 720px)': {
		width: 'min(34%, 130px)',
		margin: '-0.4rem 0 0',
		alignSelf: 'flex-end',
	},
}

const panelLedeCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '68ch',
}

/* Nested surfaces step down to the page ground so they read as wells. */
const headerGuideLinkCss = {
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
}

const discordInviteWrapCss = {
	margin: '1rem 0 0',
}

const discordInviteLinkCss = {
	...getGhostButtonCss({ size: 'sm' }),
	width: 'fit-content',
	gap: '0.4rem',
	padding: '0.4rem 0.85rem 0.4rem 0.65rem',
	font: `600 0.92rem/1 ${typography.fontFamilyBody}`,
}

const quickExampleDoneCss = {
	margin: 0,
	color: colors.primaryText,
	fontWeight: 600,
}

/* The "learn" half lives here, labeled and out of the instructions' way. */
const howItWorksCss = {
	...getAccentCalloutCss(),
	'& p': {
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.92rem',
		lineHeight: 1.55,
	},
	'& em': {
		fontStyle: 'normal',
		fontWeight: 650,
		color: colors.text,
	},
}

const howItWorksLabelCss = {
	font: `700 0.78rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

/* One-time authorization callout follows the install controls because this
   is the action users must take after copying or adding the MCP config. */
const authNoteCss = {
	...getAccentCalloutCss({ accentColor: colors.primary }),
	gap: '0.55rem',
	padding: '1.2rem 1.35rem',
	borderLeftWidth: '6px',
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.14)`,
	boxShadow: `0 10px 28px oklch(from ${colors.primary} l c h / 0.12)`,
	'& > strong': {
		font: `750 1.2rem/1.15 ${typography.fontFamilyDisplay}`,
		color: colors.primaryText,
	},
	'& > span': {
		color: colors.text,
		lineHeight: 1.5,
	},
	'& code': {
		font: '600 0.9em ui-monospace, "SF Mono", Menlo, monospace',
	},
}

/* Connection status pill: dashed while the product polls for the grant,
   solid once the agent lands. Height is locked to the check/spinner so
   sibling pills in the step-3 grid stay the same size. */
const connectStatusCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.55rem',
	width: 'fit-content',
	maxWidth: '100%',
	boxSizing: 'border-box' as const,
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.08)`,
	border: `1.5px dashed oklch(from ${colors.primary} l c h / 0.45)`,
	borderRadius: '999px',
	padding: '0.35rem 0.95rem 0.35rem 0.4rem',
	lineHeight: 1,
	'&[data-connected]': {
		borderStyle: 'solid',
	},
	'& strong': {
		lineHeight: 1.2,
		fontWeight: 700,
	},
}

const connectCheckCss = {
	flex: 'none',
	display: 'grid',
	placeItems: 'center',
	boxSizing: 'border-box' as const,
	width: '1.5rem',
	height: '1.5rem',
	borderRadius: '50%',
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontWeight: 760,
	lineHeight: 1,
	...wizardPopCss,
}

/** Match the check circle so waiting/connected pills share one height. */
const connectStatusSpinnerCss = {
	...inlineSpinnerCss,
	width: '1.5rem',
	height: '1.5rem',
}

function connectStatusContent(input: {
	connected: boolean
	connectedLabel: string
	waitingLabel: string
}) {
	// Return an array (no inter-element whitespace text nodes) so flex height
	// stays identical across sibling pills in the step-3 grid.
	if (input.connected) {
		return [
			<span key="check" mix={css(connectCheckCss)} aria-hidden="true">
				{connectedCheckIcon()}
			</span>,
			<strong key="label">{input.connectedLabel}</strong>,
		]
	}
	return [
		<span
			key="spinner"
			mix={css(connectStatusSpinnerCss)}
			aria-hidden="true"
		/>,
		<strong key="label">{input.waitingLabel}</strong>,
	]
}

function connectedCheckIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			width="14"
			height="14"
			aria-hidden="true"
			focusable={false}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M3.4 8.2 6.5 11.2 12.6 4.8" />
		</svg>
	)
}

function readOnboardingMcpOAuthError(handle: Handle) {
	const params = new URLSearchParams(readRouterSearch(handle))
	if (params.get('auth') !== 'error') return null
	return params.get('reason')
}

function Step2ConnectStatus(
	handle: Handle<{
		waiting: boolean
		connected: boolean
		exampleInstalled: boolean
		oauthError: string | null
		onNext: () => void
	}>,
) {
	return () => {
		const { waiting, connected, exampleInstalled, oauthError, onNext } =
			handle.props
		if (connected) {
			return (
				<div
					mix={css(step2ConnectedRowCss)}
					data-testid="onboarding-mcp-chooser-done"
				>
					<div
						mix={css(connectStatusCss)}
						role="status"
						aria-live="polite"
						data-connected="true"
					>
						{connectStatusContent({
							connected: true,
							connectedLabel: 'Connected',
							waitingLabel: 'Waiting for first connection…',
						})}
					</div>
					<button
						type="button"
						mix={[css(wizardNextButtonCss), on('click', onNext)]}
						data-testid="onboarding-mcp-connected-next"
					>
						Next
					</button>
				</div>
			)
		}
		if (oauthError) {
			return (
				<p mix={css(step2OAuthErrorCss)} role="alert">
					{oauthError}
				</p>
			)
		}
		if (waiting) {
			return (
				<div
					mix={css(connectStatusCss)}
					role="status"
					aria-live="polite"
					data-testid="onboarding-mcp-waiting"
				>
					{connectStatusContent({
						connected: false,
						connectedLabel: 'Connected',
						waitingLabel: 'Waiting for first connection…',
					})}
				</div>
			)
		}
		if (exampleInstalled) {
			return (
				<p mix={css(quickExampleDoneCss)} data-testid="onboarding-example-done">
					Installed — continue to try it and persist a package you own.
				</p>
			)
		}
		return null
	}
}

const step2ConnectedRowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'center',
	gap: '0.75rem 1rem',
	marginTop: '0.35rem',
}

const step2OAuthErrorCss = {
	margin: '0.35rem 0 0',
	color: colors.error,
	font: `550 0.9rem/1.45 ${typography.fontFamilyBody}`,
	textAlign: 'center' as const,
	textWrap: 'pretty' as const,
}

const step2ExitCss = {
	display: 'grid',
	gap: '0.45rem',
	marginTop: '0.35rem',
	paddingTop: '1rem',
	borderTop: `1px solid ${colors.border}`,
}

const step2ExitLabelCss = {
	margin: 0,
	font: `700 0.78rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const step2ExitLedeCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.92rem',
	lineHeight: 1.55,
	maxWidth: '68ch',
}

/* Featured starters demote to Advanced under the persist lead. */
const advancedSectionCss = {
	display: 'grid',
	gap: '0.55rem',
	marginTop: '0.6rem',
	paddingTop: '1.1rem',
	borderTop: `1px solid ${colors.border}`,
}

const advancedLabelCss = {
	margin: 0,
	display: 'flex',
	alignItems: 'center',
	gap: '0.5rem',
	font: `700 0.78rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.06em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}

const advancedBadgeCss = {
	display: 'inline-block',
	padding: '0.18rem 0.5rem',
	borderRadius: radius.full,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	font: `700 0.68rem/1 ${typography.fontFamilyBody}`,
	letterSpacing: '0.06em',
	color: colors.textMuted,
}

const advancedLedeCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.92rem',
	lineHeight: 1.55,
	maxWidth: '68ch',
}

const starterListCss = {
	listStyle: 'none',
	margin: '0.2rem 0 0',
	padding: 0,
	display: 'grid',
	gap: '0.6rem',
}

/* Starter packages: compact centered cards; the DIY card breaks the grid
   with a dashed border so "no package" reads as a real option. */
const starterGridCss = {
	listStyle: 'none',
	margin: '0.2rem 0 0',
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(12.5rem, 100%), 1fr))',
	gap: '0.9rem',
}

/* Back / Next: the wizard's only fixed geography, so it never moves. */
const wizardNavCss = {
	display: 'flex',
	justifyContent: 'space-between',
	gap: '0.8rem',
	marginTop: '0.3rem',
	paddingTop: '1.1rem',
	borderTop: `1px solid ${colors.border}`,
}

const wizardNavTrailingCss = {
	display: 'flex',
	justifyContent: 'flex-end',
	flexWrap: 'wrap' as const,
	gap: '0.6rem',
}

const wizardSkipButtonCss = {
	...getGhostButtonCss(),
	minWidth: '6.5rem',
}

const wizardButtonDisabledCss = {
	'&:disabled': {
		opacity: 0.45,
		cursor: 'not-allowed',
		transform: 'none',
		boxShadow: 'none',
	},
}

const wizardNextButtonCss = {
	...getPillButtonCss(),
	minWidth: '6.5rem',
	...wizardButtonDisabledCss,
}

const wizardBackButtonCss = {
	...getGhostButtonCss(),
	minWidth: '6.5rem',
	...wizardButtonDisabledCss,
	'&:disabled': {
		...wizardButtonDisabledCss['&:disabled'],
		boxShadow: `inset 0 0 0 1.5px ${colors.border}`,
	},
}

const authLinksCss = {
	margin: '2.2rem 0 0',
	color: colors.textMuted,
}

/* ---------- BYOK disclosure ---------- */

const byokDetailsCss = {
	marginTop: 'clamp(2.5rem, 6vw, 4rem)',
	paddingTop: '1.4rem',
	borderTop: `1px solid ${colors.border}`,
	'& > div': {
		'@media (prefers-reduced-motion: no-preference)': {
			transition: `opacity 240ms ${transitions.easeOut}, translate 240ms ${transitions.easeOut}`,
		},
		'@starting-style': {
			opacity: 0,
			translate: '0 6px',
		},
	},
}

const byokSummaryCss = {
	cursor: 'pointer',
	width: 'fit-content',
	padding: '0.3rem 0',
	font: `700 1.05rem/1.3 ${typography.fontFamilyDisplay}`,
	color: colors.text,
	transition: `color ${transitions.fast}`,
	[hoverMq]: {
		'&:hover': {
			color: colors.primaryText,
		},
	},
}

const byokBodyCss = {
	marginTop: '1.2rem',
	display: 'grid',
	gridTemplateColumns: 'clamp(160px, 24vw, 250px) minmax(0, 1fr)',
	gap: 'clamp(1.5rem, 4vw, 3rem)',
	alignItems: 'center',
	'& > img': {
		width: '100%',
		height: 'auto',
	},
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		'& > img': {
			width: 'min(48%, 200px)',
			marginInline: 'auto',
		},
	},
}

const byokTitleCss = {
	margin: 0,
	fontSize: 'clamp(1.4rem, 2.4vw, 1.75rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	lineHeight: 1.15,
}

const byokCopyCss = {
	margin: '0.85rem 0 0',
	color: colors.textMuted,
	maxWidth: '56ch',
}

const byokCompareCss = {
	margin: '1.3rem 0 0',
	display: 'grid',
	gap: '0.45rem',
	fontSize: '0.95rem',
	'& > div': {
		display: 'flex',
		alignItems: 'baseline',
		flexWrap: 'wrap' as const,
		gap: '0.6rem',
	},
	'& dt': {
		color: colors.textMuted,
		minWidth: '7.5ch',
	},
	'& dd': {
		margin: 0,
		display: 'inline-flex',
		alignItems: 'baseline',
		gap: '0.45rem',
		flexWrap: 'wrap' as const,
	},
	'& dd > span:not([aria-hidden]), & dd > s, & dd > em': {
		backgroundColor: colors.surface,
		border: `1px solid ${colors.border}`,
		borderRadius: '999px',
		padding: '0.15rem 0.7rem',
	},
	'& dd > s': {
		color: colors.textMuted,
	},
	'& dd > em': {
		fontStyle: 'normal',
		fontWeight: 600,
		color: colors.primaryText,
		borderColor: `oklch(from ${colors.primary} l c h / 0.5)`,
	},
}

const byokPointsCss = {
	margin: '1.3rem 0 0',
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: '0.55rem',
	color: colors.textMuted,
	fontSize: '0.98rem',
	'& strong': {
		color: colors.text,
	},
}
