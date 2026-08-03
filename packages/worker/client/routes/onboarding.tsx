import { type Handle, css } from 'remix/ui'
import { normalizeRedirectTo } from '#app/safe-redirect.ts'
import { CopyTextButton } from '#client/copy-text-button.tsx'
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
	AccountManagementHeader,
	AccountManagementMessage,
	AccountManagementShell,
} from '#client/routes/account-management-components.tsx'
import { type OnboardingFeaturedListing } from '#app/community-public-types.ts'
import {
	fetchOnboardingPayload,
	onboardingApiPath,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import { renderByokExplainer } from '#client/routes/byok-explainer.tsx'
import { OnboardingDiyCard } from '#client/routes/onboarding-diy-card.tsx'
import { OnboardingMcpClientTabs } from '#client/routes/onboarding-mcp-client-tabs.tsx'
import { OnboardingStarterCard } from '#client/routes/onboarding-starter-card.tsx'
import {
	onboardingPath,
	resolveOnboardingPendingVerificationPath,
} from '#client/routes/onboarding-redirect.ts'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	focusRingCss,
	getAlertCardCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	layoutMaxWidths,
	mutedLinkCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

type OnboardingStep = 1 | 2 | 3

const onboardingSteps = [
	{ number: 1, label: 'Discover', hash: 'discovery' },
	{ number: 2, label: 'Connect your agent', hash: 'connect-agent' },
	{ number: 3, label: 'Install a starter package', hash: 'starter-packages' },
] as const satisfies ReadonlyArray<{
	number: OnboardingStep
	label: string
	hash: string
}>

function isOnboardingPath(href: string) {
	return new URL(href, 'http://localhost').pathname === onboardingPath
}

function readStepFromHref(href: string): OnboardingStep | null {
	const hash = new URL(href, 'http://localhost').hash.slice(1)
	return (
		onboardingSteps.find((candidate) => candidate.hash === hash)?.number ?? null
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
	let mcpServerUrl = ''
	let setupPrompt = ''
	let discoveryPrompt = ''
	let hasMcpClient = false
	let featuredListings: Array<OnboardingFeaturedListing> = []
	let activeStep: OnboardingStep = 1
	let initializedStep = false
	let appliedInitialHash = false
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: OnboardingPayload) {
		const wasConnected = hasMcpClient
		loggedIn = payload.loggedIn
		mcpServerUrl = payload.mcpServerUrl
		setupPrompt = payload.setupPrompt
		discoveryPrompt = payload.discoveryPrompt
		hasMcpClient = payload.hasMcpClient
		featuredListings = payload.featuredListings ?? []
		status = 'ready'
		message = null
		if (!initializedStep) {
			activeStep = payload.hasMcpClient ? 3 : 1
			initializedStep = true
		} else if (!wasConnected && payload.hasMcpClient) {
			activeStep = 3
			updateStepHash(3)
		}
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
		activeStep = step
		updateStepHash(step)
		void handle.update().then((signal) => {
			if (signal.aborted) return
			const stepDefinition = onboardingSteps.find(
				(candidate) => candidate.number === step,
			)
			if (!stepDefinition) return
			document.getElementById(stepDefinition.hash)?.querySelector('h2')?.focus()
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

	// Users typically keep this page open while their MCP client runs the
	// OAuth flow, so poll the same JSON endpoint until a grant shows up and
	// collapse the completed steps without requiring a manual refresh.
	let pollIntervalId: ReturnType<typeof setInterval> | undefined
	let pollInFlight = false

	async function pollForMcpConnection() {
		if (hasMcpClient) {
			clearInterval(pollIntervalId)
			return
		}
		if (pollInFlight || status !== 'ready' || !loggedIn) return
		if (document.hidden) return
		if (!isOnboardingPath(readCurrentRouterHref(handle))) return
		pollInFlight = true
		try {
			const payload = await fetchOnboardingPayload(handle.signal)
			if (handle.signal.aborted || !payload?.hasMcpClient) return
			applyPayload(payload)
			handle.update()
		} catch {
			// Transient poll failures are fine; the next tick retries.
		} finally {
			pollInFlight = false
		}
	}

	if (typeof document !== 'undefined') {
		pollIntervalId = setInterval(pollForMcpConnection, 5000)
		handle.signal.addEventListener('abort', () => clearInterval(pollIntervalId))
		window.addEventListener('hashchange', handleHashChange)
		handle.signal.addEventListener('abort', () =>
			window.removeEventListener('hashchange', handleHashChange),
		)
	}

	function handleHashChange() {
		const step = readStepFromHref(window.location.href)
		if (!step) return
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
			isLoading: status === 'loading',
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

		return (
			<AccountManagementShell maxWidth={layoutMaxWidths.content}>
				<AccountManagementHeader
					title="Get started with Kody"
					description="Connect any MCP-capable AI agent to your Kody account, then ask it to help you set things up."
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading onboarding…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<>
						<nav aria-label="Onboarding steps" mix={css(stepIndicatorCss)}>
							{onboardingSteps.map((step) => {
								const isActive = activeStep === step.number
								const isComplete = hasMcpClient && step.number < 3
								return (
									<button
										key={step.number}
										type="button"
										aria-current={isActive ? 'step' : undefined}
										mix={[
											css({
												...stepIndicatorButtonCss,
												...(isActive ? activeStepIndicatorButtonCss : {}),
												'&:focus-visible': focusRingCss,
											}),
											on('click', () => selectStep(step.number)),
										]}
									>
										<span mix={css(stepNumberCss)}>{step.number}</span>
										<span>{step.label}</span>
										{isComplete ? (
											<span
												role="img"
												aria-label="Complete"
												mix={css(stepCompleteCss)}
											>
												✓
											</span>
										) : null}
									</button>
								)
							})}
						</nav>

						{hasMcpClient && activeStep === 3 ? (
							<section mix={css(connectedCardCss)} role="status">
								<h2 mix={css(cardTitleCss)}>You are connected</h2>
								<p mix={css(descriptionCss)}>
									Your agent has authorized access. Steps 1 and 2 are complete,
									so you can choose a starter package.
								</p>
							</section>
						) : null}

						{activeStep === 1 ? (
							<section
								id="discovery"
								mix={css(cardCss)}
								data-testid="onboarding-discovery"
							>
								<div mix={css(stepHeadingCss)}>
									<p mix={css(stepEyebrowCss)}>Step 1 · Optional</p>
									<h2 tabIndex={-1} mix={css(cardTitleCss)}>
										Discover what Kody can do
									</h2>
								</div>
								<p mix={css(descriptionCss)}>
									Paste this into any AI agent that can fetch a URL or search
									the web — ChatGPT, Claude, Grok, or whatever you already use.
									It reads Kody&apos;s docs, interviews you, and suggests
									concrete automations. You can also skip this and connect
									directly.
								</p>
								<pre mix={css(codeBlockCss)}>{discoveryPrompt}</pre>
								<div mix={css(discoveryActionsCss)}>
									<CopyTextButton
										value={discoveryPrompt}
										idleLabel="Copy discovery prompt"
										variant="secondary"
									/>
									<button
										type="button"
										mix={[css(skipButtonCss), on('click', () => selectStep(2))]}
									>
										Skip discovery
									</button>
								</div>
								<WizardNavigation
									activeStep={activeStep}
									onSelectStep={selectStep}
								/>
							</section>
						) : null}

						{activeStep === 2 ? (
							<section
								id="connect-agent"
								mix={css(cardCss)}
								data-testid="onboarding-connect-agent"
							>
								<div mix={css(stepHeadingCss)}>
									<p mix={css(stepEyebrowCss)}>Step 2</p>
									<h2 tabIndex={-1} mix={css(cardTitleCss)}>
										Connect your agent
									</h2>
								</div>
								<div mix={css(authorizationCalloutCss)} role="note">
									<strong>One-time authorization required</strong>
									<span>
										After you add the server, your client opens a browser window
										or shows an <strong>Authenticate</strong> button. Approve
										the request to finish connecting.
									</span>
								</div>
								<div
									mix={css(connectionStatusCss)}
									role="status"
									aria-live="polite"
								>
									{hasMcpClient ? (
										<>
											<span mix={css(statusIconCss)} aria-hidden="true">
												✓
											</span>
											<strong>You are connected</strong>
										</>
									) : (
										<>
											<span mix={css(spinnerCss)} aria-hidden="true" />
											<strong>Waiting for your agent to connect…</strong>
										</>
									)}
								</div>
								<OnboardingMcpClientTabs mcpServerUrl={mcpServerUrl} />
								<WizardNavigation
									activeStep={activeStep}
									onSelectStep={selectStep}
								/>
							</section>
						) : null}

						{activeStep === 3 ? (
							<>
								<section
									id="starter-packages"
									mix={css(cardCss)}
									data-testid="onboarding-starter-packages"
								>
									<div mix={css(stepHeadingCss)}>
										<p mix={css(stepEyebrowCss)}>Step 3</p>
										<h2 tabIndex={-1} mix={css(cardTitleCss)}>
											Install a starter package
										</h2>
									</div>
									<p mix={css(descriptionCss)}>
										{featuredListings.length > 0
											? 'These packages were reviewed by an admin and support one-click install here. After install, use Copy prompt so your agent can finish any remaining setup — or pick Choose your own adventure to explore with your agent instead.'
											: 'No featured starters are available right now. Copy the Choose your own adventure prompt to explore with your agent, or browse community packages.'}
									</p>
									<ul mix={css(starterGridCss)}>
										{featuredListings.map((listing) => (
											<OnboardingStarterCard
												key={listing.id}
												listing={listing}
												loggedIn={loggedIn}
											/>
										))}
										<OnboardingDiyCard setupPrompt={setupPrompt} />
									</ul>
									<p mix={css({ margin: 0 })}>
										<a href="/community" mix={css(primaryLinkCss)}>
											Browse all community packages
										</a>
									</p>
									<WizardNavigation
										activeStep={activeStep}
										onSelectStep={selectStep}
									/>
								</section>

								<details mix={css(byokDetailsCss)}>
									<summary mix={css(byokSummaryCss)}>
										Bring your own API keys
									</summary>
									{renderByokExplainer({ image: 'handoff' })}
								</details>
							</>
						) : null}

						{loggedIn ? null : (
							<p mix={css({ margin: 0 })}>
								<a href="/signup" mix={css(primaryLinkCss)}>
									Sign up
								</a>
								{' · '}
								<a href="/login" mix={css(mutedLinkCss)}>
									Log in
								</a>
							</p>
						)}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}

function WizardNavigation(
	handle: Handle<{
		activeStep: OnboardingStep
		onSelectStep: (step: OnboardingStep) => void
	}>,
) {
	return () => {
		const previousStep =
			handle.props.activeStep > 1
				? ((handle.props.activeStep - 1) as OnboardingStep)
				: null
		const nextStep =
			handle.props.activeStep < 3
				? ((handle.props.activeStep + 1) as OnboardingStep)
				: null

		return (
			<div mix={css(wizardNavigationCss)}>
				<button
					type="button"
					disabled={previousStep == null}
					mix={[
						css(wizardSecondaryButtonCss),
						on('click', () => {
							if (previousStep) handle.props.onSelectStep(previousStep)
						}),
					]}
				>
					Back
				</button>
				<button
					type="button"
					disabled={nextStep == null}
					mix={[
						css(wizardPrimaryButtonCss),
						on('click', () => {
							if (nextStep) handle.props.onSelectStep(nextStep)
						}),
					]}
				>
					Next
				</button>
			</div>
		)
	}
}

const stepIndicatorCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
	gap: spacing.sm,
	[mq.mobile]: {
		gridTemplateColumns: '1fr',
	},
}

const stepIndicatorButtonCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	padding: spacing.sm,
	border: `1px solid ${colors.border}`,
	borderRadius: 'var(--radius-md)',
	backgroundColor: colors.surface,
	color: colors.textMuted,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.sm,
	textAlign: 'left' as const,
	cursor: 'pointer',
	'&:hover': {
		borderColor: colors.primary,
		backgroundColor: colors.primarySoftest,
	},
}

const activeStepIndicatorButtonCss = {
	borderColor: colors.primary,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
}

const stepNumberCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flex: '0 0 auto',
	width: '1.75rem',
	height: '1.75rem',
	borderRadius: '999px',
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontWeight: typography.fontWeight.semibold,
}

const stepCompleteCss = {
	marginLeft: 'auto',
	color: colors.primaryText,
	fontWeight: typography.fontWeight.bold,
}

const connectedCardCss = {
	...cardCss,
	borderColor: colors.primary,
	backgroundColor: colors.primarySoftest,
}

const stepHeadingCss = {
	display: 'grid',
	gap: spacing.xs,
}

const stepEyebrowCss = {
	margin: 0,
	color: colors.primaryText,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
	textTransform: 'uppercase' as const,
	letterSpacing: '0.08em',
}

const discoveryActionsCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
}

const skipButtonCss = {
	...getSecondaryButtonCss(),
}

const authorizationCalloutCss = {
	...getAlertCardCss('info'),
	display: 'grid',
	gap: spacing.xs,
	borderWidth: '2px',
	fontSize: typography.fontSize.base,
	lineHeight: 1.5,
}

const connectionStatusCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	margin: 0,
	padding: `${spacing.sm} ${spacing.md}`,
	borderRadius: 'var(--radius-md)',
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
}

const statusIconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.5rem',
	height: '1.5rem',
	borderRadius: '999px',
	backgroundColor: colors.primary,
	color: colors.onPrimary,
}

const spinnerCss = {
	width: '1rem',
	height: '1rem',
	border: `2px solid ${colors.border}`,
	borderTopColor: colors.primary,
	borderRadius: '999px',
	animation: 'onboarding-spinner 0.8s linear infinite',
	'@keyframes onboarding-spinner': {
		to: { transform: 'rotate(360deg)' },
	},
}

const wizardNavigationCss = {
	display: 'flex',
	justifyContent: 'space-between',
	gap: spacing.sm,
	paddingTop: spacing.sm,
	borderTop: `1px solid ${colors.border}`,
}

const wizardPrimaryButtonCss = {
	...getPrimaryButtonCss(),
	minWidth: '6rem',
}

const wizardSecondaryButtonCss = {
	...getSecondaryButtonCss(),
	minWidth: '6rem',
}

const byokDetailsCss = {
	display: 'grid',
	gap: spacing.md,
}

const byokSummaryCss = {
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
	cursor: 'pointer',
}

const codeBlockCss = {
	...insetCardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-word' as const,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}

const starterGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(10.5rem, 1fr))',
	gap: spacing.md,
	margin: 0,
	padding: 0,
	listStyle: 'none',
	[mq.mobile]: {
		gridTemplateColumns: 'repeat(auto-fill, minmax(9rem, 1fr))',
		gap: spacing.sm,
	},
}
