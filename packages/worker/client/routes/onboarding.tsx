import { type Handle, css, ref } from 'remix/ui'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterSearch, readRouterUrl } from '#client/router-location.tsx'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { type OnboardingChecklistLoaderData } from '#universal/loader-data.ts'
import {
	closeOnboardingMcpOAuthPopupIfOpened,
	listenForOnboardingMcpOAuthDone,
} from '#client/mcp-oauth-popup.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import { routes } from '#universal/routes.ts'
import {
	onboardingWizardStepByNumber,
	onboardingWizardStepHref,
	onboardingWizardSteps,
	readLegacyOnboardingStep,
	type OnboardingWizardStepNumber,
} from '#universal/onboarding-process.ts'
import {
	hasInstalledOnboardingExample,
	onboardingExampleInstallFingerprint,
	selectOnboardingExampleListings,
	selectOnboardingServiceStarterListings,
} from '#universal/onboarding-examples.ts'
import {
	customOnboardingMcpFingerprint,
	featuredOnboardingMcpFingerprint,
	hasConnectedOnboardingWorkspaceMcp,
	hasPendingOnboardingCustomMcpAuth,
	hasPendingOnboardingFeaturedMcpAuth,
} from '#universal/onboarding-mcp-chooser.ts'
import {
	fetchOnboardingPayload,
	onboardingApiPath,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import { isOnboardingChecklistItemDone } from '#client/routes/onboarding-checklist.tsx'
import {
	type OnboardingAgentChooserPick,
	type OnboardingAgentSurface,
	onboardingAgentLabel,
	onboardingDataHref,
	onboardingMobileAgentMediaQuery,
	pickOnboardingAgentChooser,
	readOnboardingAgentParam,
	readOnboardingSurfaceParam,
} from '#client/routes/onboarding-mcp-clients.ts'
import {
	renderAccessPanel,
	renderConnectAgentPanel,
	renderPersistPanel,
} from '#client/routes/onboarding-wizard-panels.tsx'
import { renderWizardStepsNav } from '#client/routes/onboarding-wizard-chrome.tsx'
import { ProviderIcon } from '#client/provider-icons.tsx'
import {
	onboardingPath,
	resolveOnboardingPendingVerificationPath,
} from '#client/routes/onboarding-redirect.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

/**
 * Onboarding wizard: shirt-pattern head, three-step stepper (Connect your
 * agent · Give Kody Access · Try it, then persist), one surface panel at a
 * time with hand-tilted mascot art. Step 1 picks one agent, then shows only
 * that host. Server state (prompts, MCP URL, featured MCP servers,
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

type OnboardingStep = OnboardingWizardStepNumber

const onboardingSteps = onboardingWizardSteps

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
		readLegacyOnboardingStep(hash)
	)
}

function readOnboardingRedirectTo(handle: Handle) {
	return normalizeRedirectTo(
		new URLSearchParams(readRouterSearch(handle)).get('redirectTo'),
	)
}

function readOnboardingMcpOAuthError(handle: Handle) {
	const params = new URLSearchParams(readRouterSearch(handle))
	if (params.get('auth') !== 'error') return null
	return params.get('reason')
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
	return {
		onboarding: payload,
		onboardingAgentChooser: pickOnboardingAgentChooser(),
	}
}

export function OnboardingRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let message: string | null = null
	let loggedIn = false
	let username: string | null = null
	let mcpServerUrl = ''
	let mcpHighlights: OnboardingPayload['mcpHighlights'] = {}
	let setupPrompt = ''
	let persistPrompt = ''
	let hasMcpClient = false
	let hasStep2Win = false
	let hasPersistedPackage = false
	let persistedPackageKodyId: string | null = null
	let featuredListings: Array<OnboardingFeaturedListing> = []
	let exampleListings: Array<OnboardingFeaturedListing> = []
	let serviceStarterListings: Array<OnboardingFeaturedListing> = []
	let featuredMcpServers: OnboardingPayload['featuredMcpServers'] = []
	let customMcpServers: OnboardingPayload['customMcpServers'] = []
	let checklist: OnboardingChecklistLoaderData | null = null
	let checklistHidden = false
	let initializedStep = false
	let pendingAdvanceToAccess = false
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
		mcpHighlights = payload.mcpHighlights ?? {}
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
			initializedStep = true
			return
		}
		if (!wasConnected && payload.hasMcpClient && !hasStep2Win) {
			panelAnimationArmed = true
			scrollToNav('onboarding-steps-nav')
			pendingAdvanceToAccess = true
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

	function buildStepHref(
		step: OnboardingStep,
		href = readCurrentRouterHref(handle),
	) {
		const current = new URL(href, 'https://kody.local')
		return onboardingWizardStepHref(current.pathname, step, current.search)
	}

	function goToStep(step: OnboardingStep) {
		if (typeof window === 'undefined') return
		navigate(buildStepHref(step, window.location.href), {
			preventScrollReset: true,
		})
	}

	function flushPendingAdvanceToAccess(defer: boolean) {
		if (!pendingAdvanceToAccess) return
		if (!defer) {
			pendingAdvanceToAccess = false
			goToStep(2)
			return
		}
		// Hash navigate is synchronous and calls handle.update(). Loader
		// consumption and its corrective render both run around this paint,
		// so keep the flag until the queued task actually navigates.
		handle.queueTask((signal) => {
			if (signal.aborted || !pendingAdvanceToAccess) return
			pendingAdvanceToAccess = false
			goToStep(2)
		})
	}

	let viewportSurface: OnboardingAgentSurface = 'desktop'
	let agentChooser: OnboardingAgentChooserPick | null = null

	handle.queueTask((signal) => {
		if (typeof matchMedia !== 'function') return
		const media = matchMedia(onboardingMobileAgentMediaQuery)
		const sync = () => {
			const next: OnboardingAgentSurface = media.matches ? 'mobile' : 'desktop'
			if (next === viewportSurface) return
			viewportSurface = next
			handle.update()
		}
		sync()
		media.addEventListener('change', sync, { signal })
	})

	function selectStep(step: OnboardingStep) {
		panelAnimationArmed = true
		scrollToNav('onboarding-steps-nav')
		goToStep(step)
		handle.queueTask((signal) => {
			if (signal.aborted) return
			// The nav scroll owns the viewport position; focus must not yank
			// it back down to the panel heading.
			document
				.getElementById(onboardingWizardStepByNumber(step).hash)
				?.querySelector('h2')
				?.focus({ preventScroll: true })
		})
	}

	async function refreshOnboardingAfterInstall() {
		try {
			const payload = await fetchOnboardingPayload(handle.signal)
			if (handle.signal.aborted || !payload) return
			applyPayload(payload)
			flushPendingAdvanceToAccess(false)
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
			flushPendingAdvanceToAccess(false)
			if (!agentChooser) agentChooser = pickOnboardingAgentChooser()
			loadLatch.markLoaded(onboardingDataHref(href))
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load onboarding.'
			loadLatch.markFailed(onboardingDataHref(href))
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
			flushPendingAdvanceToAccess(false)
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

	function applyRouteLoaderData(href: string) {
		if (!isOnboardingPath(href)) return false
		const chooserData = tryConsumeRouteLoaderData(
			handle,
			'onboardingAgentChooser',
			href,
		)
		if (chooserData) agentChooser = chooserData
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
		loadLatch.markLoaded(onboardingDataHref(href))
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		flushPendingAdvanceToAccess(true)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref: onboardingDataHref(currentHref),
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadOnboarding)
		}

		const inferredStep: OnboardingStep = hasStep2Win ? 3 : hasMcpClient ? 2 : 1
		const activeStep = readStepFromHref(currentHref) ?? inferredStep

		const routerSearch = readRouterSearch(handle)
		const selectedAgent = readOnboardingAgentParam(routerSearch)
		const selectedSurface =
			readOnboardingSurfaceParam(routerSearch) ?? viewportSurface
		const selectedAgentLabel = selectedAgent
			? onboardingAgentLabel(selectedAgent, selectedSurface)
			: null
		const agentLocation = new URL(readRouterUrl(handle), 'https://kody.local')

		const onChanged = () => {
			void refreshOnboardingAfterInstall()
		}
		const onAuthStarted = () => {
			awaitingMcpConnection = true
			handle.update()
		}

		return (
			<section mix={css(onboardCss)}>
				<header mix={css(onboardHeadCss)}>
					<h1 data-rise style={{ '--rise': '0' }}>
						Get started with <em>Kody</em>
					</h1>
					<p
						data-rise
						style={{ '--rise': '1' }}
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
						{renderWizardStepsNav({
							activeStep,
							hasMcpClient,
							hasStep2Win,
							stepHref: (step) => buildStepHref(step, currentHref),
						})}

						{activeStep === 1
							? renderConnectAgentPanel({
									entrance: panelEntrance(),
									activeStep,
									onSelectStep: selectStep,
									hasMcpClient,
									selectedAgent,
									selectedAgentLabel,
									selectedSurface,
									agentChooser,
									mcpServerUrl,
									mcpHighlights: mcpHighlights ?? {},
									agentLocation: {
										pathname: agentLocation.pathname,
										search: agentLocation.search,
										hash: agentLocation.hash,
									},
								})
							: null}

						{activeStep === 2
							? renderAccessPanel({
									entrance: panelEntrance(),
									activeStep,
									onSelectStep: selectStep,
									loggedIn,
									username,
									hasStep2Win,
									awaitingMcpConnection,
									oauthReturnSucceeded,
									oauthReturnError,
									urlOauthError: readOnboardingMcpOAuthError(handle),
									featuredMcpServers,
									customMcpServers,
									exampleListings,
									onChanged,
									onAuthStarted,
								})
							: null}

						{activeStep === 3
							? renderPersistPanel({
									entrance: panelEntrance(),
									activeStep,
									onSelectStep: selectStep,
									loggedIn,
									setupPrompt,
									persistPrompt,
									hasPersistedPackage,
									persistedPackageKodyId,
									ownedExampleKodyId: readOwnedExampleKodyId(exampleListings),
									featuredMcpServers,
									customMcpServers,
									exampleListings,
									serviceStarterListings,
									checklist,
									checklistHidden,
									onChecklistDismissed: () => {
										checklistHidden = true
										handle.update()
									},
								})
							: null}
					</>
				) : null}
			</section>
		)
	}
}

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

/* Nested surfaces step down to the page ground so they read as wells. */
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
