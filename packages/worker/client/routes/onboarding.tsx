import { type Handle, css, ref } from 'remix/ui'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import { type AccountStatus } from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	closeOnboardingMcpOAuthPopupIfOpened,
	listenForOnboardingMcpOAuthDone,
} from '#client/mcp-oauth-popup.ts'
import { routes } from '#universal/routes.ts'
import {
	isOnboardingPagePath,
	onboardingIndexRedirectHref,
	onboardingSessionMilestonesComplete,
	onboardingSessionMilestonesEqual,
	onboardingStepPaths,
	onboardingWizardStepByNumber,
	onboardingWizardStepHref,
	parseOnboardingPathname,
	emptyOnboardingSessionMilestones,
	type OnboardingSessionMilestoneState,
	type OnboardingWizardStepNumber,
} from '#universal/onboarding-process.ts'
import {
	fetchOnboardingPayload,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import {
	type OnboardingAgentChooserPick,
	onboardingAgentLabel,
	onboardingDataHref,
} from '#client/routes/onboarding-mcp-clients.ts'
import {
	rememberOnboardingAgentChooser,
	resolveOnboardingAgentChooser,
} from '#client/routes/onboarding-agent-chooser-session.ts'
import {
	rememberOnboardingServiceChooser,
	resolveOnboardingServiceChooser,
} from '#client/routes/onboarding-service-chooser-session.ts'
import {
	readRememberedOnboardingSelectedAgent,
	rememberOnboardingSelectedAgent,
} from '#client/routes/onboarding-selected-agent-session.ts'
import { type OnboardingServiceChooserPick } from '#universal/onboarding-mcp-chooser.ts'
import {
	OnboardingAccessPanel,
	renderConnectAgentPanel,
} from '#client/routes/onboarding-wizard-panels.tsx'
import { renderWizardStepsNav } from '#client/routes/onboarding-wizard-chrome.tsx'
import { ProviderIcon } from '#client/provider-icons.tsx'
import { resolveOnboardingPendingVerificationPath } from '#client/routes/onboarding-redirect.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

/**
 * Onboarding wizard: shirt-pattern head, two-step stepper (Connect your
 * agent · Give Kody Access), one surface panel at a time with hand-tilted
 * mascot art. Step 1 picks one agent, then shows only that host.
 *
 * Step 2 is prompt-first. The first row is official MCP remotes plus Not
 * listed. Picking a chip flavors a short copyable prompt. Not listed is
 * "ask your agent" plus optional logos that only update that prompt.
 * Hosted OAuth is not the path. Live milestones observe account activity.
 */

type OnboardingStep = OnboardingWizardStepNumber

function isOnboardingPath(href: string) {
	return isOnboardingPagePath(new URL(href, 'http://localhost').pathname)
}

function readOnboardingLocation(href: string) {
	const url = new URL(href, 'http://localhost')
	return parseOnboardingPathname(url.pathname)
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
	const payload = await fetchOnboardingPayload(signal)
	if (!payload) {
		throw new Error('Unable to load onboarding.')
	}
	if (payload.loggedIn && !payload.emailVerified) {
		return routeLoaderRedirect(
			resolveOnboardingPendingVerificationPath(redirectTo),
		)
	}
	if (url.pathname === onboardingStepPaths.index) {
		return routeLoaderRedirect(onboardingIndexRedirectHref(url.search))
	}
	const location = parseOnboardingPathname(url.pathname)
	if (location && !location.valid) {
		return routeLoaderRedirect(
			onboardingWizardStepHref(location.step, url.search),
		)
	}
	return {
		onboarding: payload,
		onboardingAgentChooser: resolveOnboardingAgentChooser(),
		onboardingServiceChooser: resolveOnboardingServiceChooser(),
	}
}

export function OnboardingRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let message: string | null = null
	let loggedIn = false
	let mcpServerUrl = ''
	let mcpHighlights: OnboardingPayload['mcpHighlights'] = {}
	let discoveryPrompt = ''
	let hasMcpClient = false
	let milestones: OnboardingSessionMilestoneState =
		emptyOnboardingSessionMilestones
	let initializedStep = false
	let pendingAdvanceToAccess = false
	// Panel entrances only play for real step changes, never on the first
	// paint — the page-open choreography belongs to the head's data-rise.
	let panelAnimationArmed = false
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: OnboardingPayload) {
		const wasConnected = hasMcpClient
		loggedIn = payload.loggedIn
		mcpServerUrl = payload.mcpServerUrl
		mcpHighlights = payload.mcpHighlights ?? {}
		discoveryPrompt = payload.discoveryPrompt
		milestones = payload.milestones ?? emptyOnboardingSessionMilestones
		hasMcpClient = payload.hasMcpClient
		status = 'ready'
		message = null
		if (!initializedStep) {
			initializedStep = true
			return
		}
		if (!wasConnected && payload.hasMcpClient) {
			panelAnimationArmed = true
			pendingAdvanceToAccess = true
		}
	}

	function buildStepHref(
		step: OnboardingStep,
		href = readCurrentRouterHref(handle),
	) {
		const current = new URL(href, 'https://kody.local')
		return onboardingWizardStepHref(step, current.search)
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
		// Route navigate is async. Loader consumption and its corrective
		// render both run around this paint, so keep the flag until the
		// queued task actually navigates.
		handle.queueTask((signal) => {
			if (signal.aborted || !pendingAdvanceToAccess) return
			pendingAdvanceToAccess = false
			goToStep(2)
		})
	}

	let agentChooser: OnboardingAgentChooserPick | null = null
	let serviceChooser: OnboardingServiceChooserPick | null = null

	function selectStep(step: OnboardingStep) {
		panelAnimationArmed = true
		goToStep(step)
		handle.queueTask((signal) => {
			if (signal.aborted) return
			document
				.getElementById(onboardingWizardStepByNumber(step).panelId)
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
			const payload = await fetchOnboardingPayload(signal)
			if (signal.aborted) return
			if (!payload) {
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
			if (!agentChooser) agentChooser = resolveOnboardingAgentChooser()
			if (!serviceChooser) serviceChooser = resolveOnboardingServiceChooser()
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

	// Users typically keep this page open while their MCP client connects
	// or first-session milestones land, so poll the same JSON endpoint until
	// those signals arrive without a manual refresh.
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
		if (hasMcpClient && onboardingSessionMilestonesComplete(milestones)) {
			return
		}
		if (document.hidden) return
		if (!isOnboardingPath(readCurrentRouterHref(handle))) return
		pollInFlight = true
		try {
			const payload = await fetchOnboardingPayload(handle.signal)
			if (handle.signal.aborted || !payload) return
			const nextMilestones =
				payload.milestones ?? emptyOnboardingSessionMilestones
			if (
				payload.hasMcpClient === hasMcpClient &&
				onboardingSessionMilestonesEqual(nextMilestones, milestones)
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
		listenForOnboardingMcpOAuthDone(() => {
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
		if (chooserData) {
			rememberOnboardingAgentChooser(chooserData)
			agentChooser = chooserData
		}
		const serviceChooserData = tryConsumeRouteLoaderData(
			handle,
			'onboardingServiceChooser',
			href,
		)
		if (serviceChooserData) {
			rememberOnboardingServiceChooser(serviceChooserData)
			serviceChooser = serviceChooserData
		}
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

		const location = readOnboardingLocation(currentHref)
		const activeStep: OnboardingStep = location?.valid
			? location.step
			: hasMcpClient
				? 2
				: 1
		const selectedAgent = location?.valid ? location.agent : null
		const selectedService = location?.valid ? location.service : null
		if (selectedAgent) rememberOnboardingSelectedAgent(selectedAgent)
		const selectedAgentLabel = selectedAgent
			? onboardingAgentLabel(selectedAgent)
			: null
		const rememberedAgent =
			selectedAgent ?? readRememberedOnboardingSelectedAgent()
		const connectedAgentLabel =
			rememberedAgent && rememberedAgent !== 'other'
				? onboardingAgentLabel(rememberedAgent)
				: null

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
							milestonesComplete:
								onboardingSessionMilestonesComplete(milestones),
							stepHref: (step) => buildStepHref(step, currentHref),
						})}

						{activeStep === 1
							? renderConnectAgentPanel({
									entrance: panelEntrance(),
									activeStep,
									onSelectStep: selectStep,
									hasMcpClient,
									loggedIn,
									selectedAgent,
									selectedAgentLabel,
									agentChooser,
									mcpServerUrl,
									mcpHighlights: mcpHighlights ?? {},
									search: readRouterSearch(handle),
								})
							: null}

						{activeStep === 2 ? (
							<OnboardingAccessPanel
								entrance={panelEntrance()}
								activeStep={activeStep}
								onSelectStep={selectStep}
								hasMcpClient={hasMcpClient}
								discoveryPrompt={discoveryPrompt}
								milestones={milestones}
								selectedService={selectedService}
								serviceChooser={serviceChooser}
								selectedAgentLabel={connectedAgentLabel}
								search={readRouterSearch(handle)}
							/>
						) : null}
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
