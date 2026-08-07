import { type Handle, css, ref } from 'remix/ui'
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
import { type OnboardingChecklistLoaderData } from '#app/loader-data.ts'
import { type OnboardingFeaturedListing } from '#app/community-public-types.ts'
import {
	fetchOnboardingPayload,
	onboardingApiPath,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import { OnboardingDiyCard } from '#client/routes/onboarding-diy-card.tsx'
import {
	OnboardingChecklistCard,
	shouldShowOnboardingChecklist,
} from '#client/routes/onboarding-checklist.tsx'
import { OnboardingMcpClientTabs } from '#client/routes/onboarding-mcp-client-tabs.tsx'
import { OnboardingStarterCard } from '#client/routes/onboarding-starter-card.tsx'
import {
	onboardingPath,
	resolveOnboardingPendingVerificationPath,
} from '#client/routes/onboarding-redirect.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#client/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	inlineSpinnerCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

/**
 * Onboarding wizard, ported from the redesign prototype
 * (`landing/onboarding.html`): shirt-pattern head, four-step stepper
 * (Discover · Connect your agent · See it work · Install a starter package), one surface
 * panel at a time with hand-tilted mascot art, and the BYOK argument folded
 * behind a disclosure. All server state (prompts, MCP URL, featured
 * listings, hasMcpClient polling) stays exactly as before — this is a
 * restyle, not a rearchitecture.
 */

type OnboardingStep = 1 | 2 | 3 | 4

const onboardingSteps = [
	{ number: 1, label: 'Discover', hash: 'discovery' },
	{ number: 2, label: 'Connect your agent', hash: 'connect-agent' },
	{ number: 3, label: 'See it work', hash: 'first-win' },
	{ number: 4, label: 'Install a starter package', hash: 'starter-packages' },
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
	let introEmailPrompt = ''
	let memoryPrompt = ''
	let hasMcpClient = false
	let featuredListings: Array<OnboardingFeaturedListing> = []
	let checklist: OnboardingChecklistLoaderData | null = null
	let checklistHidden = false
	let activeStep: OnboardingStep = 1
	let initializedStep = false
	let appliedInitialHash = false
	// Panel entrances only play for real step changes, never on the first
	// paint — the page-open choreography belongs to the head's data-rise.
	let panelAnimationArmed = false
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: OnboardingPayload) {
		const wasConnected = hasMcpClient
		loggedIn = payload.loggedIn
		mcpServerUrl = payload.mcpServerUrl
		setupPrompt = payload.setupPrompt
		discoveryPrompt = payload.discoveryPrompt
		introEmailPrompt = payload.introEmailPrompt
		memoryPrompt = payload.memoryPrompt
		hasMcpClient = payload.hasMcpClient
		featuredListings = payload.featuredListings ?? []
		checklist = payload.checklist
		if (payload.checklist?.dismissed) checklistHidden = true
		status = 'ready'
		message = null
		if (!initializedStep) {
			activeStep = payload.hasMcpClient ? 3 : 1
			initializedStep = true
		} else if (!wasConnected && payload.hasMcpClient) {
			panelAnimationArmed = true
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
		panelAnimationArmed = true
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

	// Users typically keep this page open while their MCP client runs the
	// OAuth flow, so poll the same JSON endpoint until a grant shows up and
	// collapse the completed steps without requiring a manual refresh.
	//
	// The interval must stay clear of 5000ms: workerd's HTTP server closes
	// idle keep-alive connections after exactly 5s (kj pipeline timeout), so
	// a 5s poll makes every request race the close. wrangler >= 4.114 turns
	// that race's "Network connection lost" ProxyWorker error into a fatal
	// dev-server exit (cloudflare/workers-sdk#14926). Polling faster than 5s
	// keeps the connection warm so the race never happens.
	const mcpConnectionPollIntervalMs = 4000
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
		pollIntervalId = setInterval(
			pollForMcpConnection,
			mcpConnectionPollIntervalMs,
		)
		handle.signal.addEventListener('abort', () => clearInterval(pollIntervalId))
		window.addEventListener('hashchange', handleHashChange)
		handle.signal.addEventListener('abort', () =>
			window.removeEventListener('hashchange', handleHashChange),
		)
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
			<section mix={css(onboardCss)}>
				<header mix={css(onboardHeadCss)}>
					<h1 data-rise style={{ '--rise': '0' }}>
						Get started with <em>Kody</em>
					</h1>
					<p data-rise style={{ '--rise': '1' }}>
						Connect any MCP-capable AI agent to your Kody account, then ask it
						to help you set things up.
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
						<nav aria-label="Onboarding steps" mix={css(wizardStepsCss)}>
							{onboardingSteps.map((step) => {
								const isActive = activeStep === step.number
								const isComplete = hasMcpClient && step.number < 3
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
								id="discovery"
								aria-labelledby="discovery-title"
								data-testid="onboarding-discovery"
								mix={[css(wizardPanelCss), panelEntrance()]}
							>
								<div mix={css(panelHeadCss)}>
									<div>
										<p mix={css(panelKickerCss)}>Step 1 · Optional</p>
										<h2
											id="discovery-title"
											tabIndex={-1}
											mix={css(panelTitleCss)}
										>
											Discover what Kody can do
										</h2>
									</div>
									<img
										data-panel-art
										src="/images/kody-agent-briefing.webp"
										width={627}
										height={627}
										loading="lazy"
										alt="Kody holding up a checklist card with both paws"
										style={{ '--tilt': '-2.5deg' }}
										mix={css(panelArtCss)}
									/>
								</div>
								<p mix={css(panelLedeCss)}>
									Paste this into any AI agent that can fetch a URL or search
									the web — ChatGPT, Claude, Grok, or whatever you already use.
									It reads Kody&apos;s docs, interviews you, and suggests
									concrete automations. You can also skip this and connect
									directly.
								</p>
								<figure mix={css(promptBlockCss)}>
									<blockquote>{discoveryPrompt}</blockquote>
								</figure>
								<div mix={css(panelActionsCss)}>
									<CopyTextButton
										value={discoveryPrompt}
										idleLabel="Copy discovery prompt"
										variant="pill"
									/>
									<button
										type="button"
										mix={[
											css(ghostActionButtonCss),
											on('click', () => selectStep(2)),
										]}
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
								aria-labelledby="connect-title"
								data-testid="onboarding-connect-agent"
								mix={[css(wizardPanelCss), panelEntrance()]}
							>
								<div mix={css(panelHeadCss)}>
									<div>
										<p mix={css(panelKickerCss)}>Step 2</p>
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
								<div mix={css(authNoteCss)} role="note">
									<strong>One-time authorization required</strong>
									<span>
										After you add the server, your client opens a browser window
										or shows an <strong>Authenticate</strong> button. Approve
										the request to finish connecting.
									</span>
								</div>
								<div
									mix={css(connectStatusCss)}
									role="status"
									aria-live="polite"
									data-connected={hasMcpClient ? 'true' : undefined}
								>
									{hasMcpClient ? (
										<>
											<span mix={css(connectCheckCss)} aria-hidden="true">
												✓
											</span>
											<strong>You are connected</strong>
										</>
									) : (
										<>
											<span mix={css(inlineSpinnerCss)} aria-hidden="true" />
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
							<section
								id="first-win"
								aria-labelledby="first-win-title"
								data-testid="onboarding-first-win"
								mix={[css(wizardPanelCss), panelEntrance()]}
							>
								<div mix={css(panelHeadCss)}>
									<div>
										<p mix={css(panelKickerCss)}>Step 3</p>
										<h2
											id="first-win-title"
											tabIndex={-1}
											mix={css(panelTitleCss)}
										>
											See it work
										</h2>
									</div>
									<img
										data-panel-art
										src="/images/kody-greeting.webp"
										width={627}
										height={627}
										loading="lazy"
										alt="Kody waving beside a warm envelope"
										style={{ '--tilt': '1.5deg' }}
										mix={css(panelArtCss)}
									/>
								</div>
								<p mix={css(panelLedeCss)}>
									Paste these into your connected agent — Kody stores what
									lands, and your agent reads it back when you ask.
								</p>
								<div mix={css(firstWinGridCss)}>
									<article mix={css(firstWinCardCss)}>
										<h3 mix={css(firstWinCardTitleCss)}>Say hello</h3>
										<p mix={css(firstWinGuidanceCss)}>
											Paste this into your connected agent; Kody emails you from
											your own Kody address within a minute. When it lands,
											reply to it — then ask your agent what you said. Kody
											stores your reply; nothing answers by itself until your
											agent reads it.
										</p>
										<figure mix={css(promptBlockCss)}>
											<blockquote>{introEmailPrompt}</blockquote>
										</figure>
										<CopyTextButton
											value={introEmailPrompt}
											idleLabel="Copy hello prompt"
											variant="pill"
										/>
									</article>
									<article mix={css(firstWinCardCss)}>
										<h3 mix={css(firstWinCardTitleCss)}>
											Teach Kody about you
										</h3>
										<p mix={css(firstWinGuidanceCss)}>
											Your agent will ask a couple of questions and save durable
											memories that follow you across every agent connected to
											your account.
										</p>
										<figure mix={css(promptBlockCss)}>
											<blockquote>{memoryPrompt}</blockquote>
										</figure>
										<CopyTextButton
											value={memoryPrompt}
											idleLabel="Copy memory prompt"
											variant="pill"
										/>
									</article>
								</div>
								<WizardNavigation
									activeStep={activeStep}
									onSelectStep={selectStep}
								/>
							</section>
						) : null}

						{activeStep === 4 ? (
							<section
								id="starter-packages"
								aria-labelledby="starters-title"
								data-testid="onboarding-starter-packages"
								mix={[css(wizardPanelCss), panelEntrance()]}
							>
								<div mix={css(panelHeadCss)}>
									<div>
										<p mix={css(panelKickerCss)}>Step 4</p>
										<h2
											id="starters-title"
											tabIndex={-1}
											mix={css(panelTitleCss)}
										>
											Install a starter package
										</h2>
									</div>
									<img
										data-panel-art
										src="/images/kody-community-packages.webp"
										width={627}
										height={627}
										loading="lazy"
										alt="Kody kneeling beside a stack of parcels, one open and glowing with a eucalyptus sprig"
										style={{ '--tilt': '-1.5deg' }}
										mix={css(panelArtCss)}
									/>
								</div>
								<p mix={css(panelLedeCss)}>
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
								<p mix={css({ margin: '0.2rem 0 0' })}>
									<a href="/community" mix={css(primaryLinkCss)}>
										Browse all community packages
									</a>
								</p>
								{/* The last step doubles as the "what's left" recap, so the
								    derived checklist lives here instead of distracting from
								    the earlier steps. */}
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
	}>,
) {
	return () => {
		const previousStep =
			handle.props.activeStep > 1
				? ((handle.props.activeStep - 1) as OnboardingStep)
				: null
		const nextStep =
			handle.props.activeStep < 4
				? ((handle.props.activeStep + 1) as OnboardingStep)
				: null

		return (
			<footer mix={css(wizardNavCss)}>
				<button
					type="button"
					disabled={previousStep == null}
					mix={[
						css(wizardBackButtonCss),
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
						css(wizardNextButtonCss),
						on('click', () => {
							if (nextStep) handle.props.onSelectStep(nextStep)
						}),
					]}
				>
					Next
				</button>
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
		<details mix={css(byokDetailsCss)}>
			<summary mix={css(byokSummaryCss)}>Bring your own API keys</summary>
			{/*
			 * A `section` rather than a `div`: a generic element has no role, so
			 * the accessible name from `aria-labelledby` would be dropped.
			 */}
			<section mix={css(byokBodyCss)} aria-labelledby="byok-note-title">
				<img
					src="/images/kody-keys.webp"
					width={627}
					height={627}
					loading="lazy"
					alt="Kody holding a golden key with both paws"
				/>
				<div>
					<h2 id="byok-note-title" mix={css(byokTitleCss)}>
						Why there&apos;s no one-click connect
					</h2>
					<p mix={css(byokCopyCss)}>
						Kody never asks a company for access on your behalf. You create the
						connection yourself, and your agent walks you through it, so it is
						completely yours: your app, your scopes, no middleman.
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
	gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
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
const promptBlockCss = {
	margin: 0,
	minWidth: 0,
	'& blockquote': {
		margin: 0,
		/*
		 * The prompt embeds full URLs, which are unbreakable words. Without this
		 * the blockquote's min-content width is the longest URL, and since a grid
		 * item cannot shrink below min-content that width propagated all the way
		 * out to the page — 172px of horizontal scroll on a 390px viewport,
		 * dragging the lede, the action row, and the wizard footer wide with it.
		 */
		overflowWrap: 'anywhere' as const,
		fontSize: '0.98rem',
		lineHeight: 1.6,
		color: colors.text,
		backgroundColor: colors.background,
		border: `1.5px solid ${colors.border}`,
		borderRadius: radius.card,
		padding: '1.1rem 1.3rem',
	},
}

const panelActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.6rem',
}

const firstWinGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(16rem, 100%), 1fr))',
	gap: '0.9rem',
}

const firstWinCardCss = {
	display: 'grid',
	gap: '0.75rem',
	padding: '1rem 1.1rem',
	backgroundColor: colors.background,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	minWidth: 0,
}

const firstWinCardTitleCss = {
	margin: 0,
	fontSize: '1.02rem',
	fontWeight: 700,
	lineHeight: 1.3,
}

const firstWinGuidanceCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.94rem',
	lineHeight: 1.55,
}

const ghostActionButtonCss = getGhostButtonCss()

/* One-time authorization callout: the only hard-edged warning on the page. */
const authNoteCss = {
	display: 'grid',
	gap: '0.3rem',
	padding: '1rem 1.2rem',
	border: `2px solid oklch(from ${colors.primary} l c h / 0.45)`,
	borderRadius: radius.card,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.06)`,
	/* Tinted wells forfeit the muted gray: body text keeps ink weight but
	   leans toward the well's green so the callout reads as one material. */
	'& > span': {
		color: `oklch(from ${colors.text} l 0.05 145)`,
	},
}

/* Connection status pill: dashed while the product polls for the grant,
   solid once the agent lands. */
const connectStatusCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.7rem',
	width: 'fit-content',
	color: colors.primaryText,
	backgroundColor: `oklch(from ${colors.primary} l c h / 0.08)`,
	border: `1.5px dashed oklch(from ${colors.primary} l c h / 0.45)`,
	borderRadius: '999px',
	padding: '0.65rem 1.2rem',
	'&[data-connected]': {
		borderStyle: 'solid',
	},
}

const connectCheckCss = {
	flex: 'none',
	display: 'grid',
	placeItems: 'center',
	width: '1.5rem',
	height: '1.5rem',
	borderRadius: '50%',
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontWeight: 760,
	...wizardPopCss,
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
