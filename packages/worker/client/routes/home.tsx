import { type Handle, ref } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { observeNearViewport } from '#client/deferred-turnstile.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	fetchOnboardingPayload,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import { onboardingPath } from '#client/routes/onboarding-redirect.ts'
import { pendingVerificationPath } from '#client/routes/pending-verification-path.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { CodeRunsTicker } from '#client/code-runs-ticker.tsx'
import { fetchCodeRunsPayload } from '#client/routes/code-runs-payload.ts'
import { type PublicCodeRunsWindow } from '#universal/code-runs.ts'
import { reveal, revealPop } from '#client/reveal.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import { landingArtAttrs } from '#universal/landing-images.ts'
import { homepageSignupPath } from '#universal/first-touch-attribution.ts'
import { type SignupMode } from '#universal/signup-mode.ts'
import {
	pickWalkthroughHosts,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import { LandingHeroAgents } from '#client/routes/landing-hero-agents.tsx'
import { LandingTestimonialsCarousel } from './landing-testimonials-carousel.tsx'
import { LandingLoopPlayer } from './landing-loop-player.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'

/**
 * heykody.app landing page, ported from the redesign prototype
 * (`landing/landing.html`). Flat neutral canvas, one vibrant green accent,
 * centered single-column flow, mascot illustrations doing the explanatory
 * work. Motion is enhance-only (`html.js`) and fully off under
 * `prefers-reduced-motion`.
 *
 * Positioning (public door): Kody is the home your agents share — for the
 * agents you use today and the ones you'll use tomorrow. The hero stage
 * (Kody with the host agents tethered around it) names the agents; the H1
 * matches the OG card. Factory / npm / packages stay below the fold.
 *
 * Layout styles live in `public/styles.css` (`.landing-*`) so SSR does not
 * emit a per-node `<style data-rmx>` tag for every marketing block.
 */

const factoryBeats = [
	{
		trigger: 'Cron',
		title: 'Shipping digest',
		copy: 'Yesterday’s releases and new public repos, mailed only when the list is not empty.',
	},
	{
		trigger: 'Webhook',
		title: 'Issue triage',
		copy: 'A new issue hits the webhook and your triage package kicks off a cloud agent. No manual trigger.',
	},
	{
		trigger: 'Invoke',
		title: 'Livestream archive',
		copy: 'A Worker posts to the invoke URL. The export locks the VOD and files it. No model in the loop.',
	},
] as const

const honestRows = [
	{
		from: 'Ask again tomorrow',
		to: 'A saved export. No model in the loop.',
	},
	{
		from: 'A key in chat or a .env',
		to: 'A secret the agent never sees.',
	},
	{
		from: 'Re-run the agent on a timer',
		to: 'A job that runs while you are offline.',
	},
	{
		from: 'Context stuck in one host',
		to: 'Memories that follow the account.',
	},
] as const

const worldBrands = [
	{ label: 'Spotify', icon: 'spotify' },
	{ label: 'Stripe', icon: 'stripe' },
	{ label: 'Resend', icon: 'resend' },
	{ label: 'Kit', icon: 'kit' },
	{ label: 'Cal.com', icon: 'caldotcom' },
	{ label: 'PayPal', icon: 'paypal' },
	{ label: 'X', icon: 'x' },
	{ label: 'Bluesky', icon: 'bluesky' },
	{ label: 'Twitch', icon: 'twitch' },
	{ label: 'Sentry', icon: 'sentry' },
	{ label: 'Fly.io', icon: 'flydotio' },
	{ label: 'Raycast', icon: 'raycast' },
	{ label: 'GroupMe', icon: 'groupme' },
] as const

function isHomePath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/'
}

function chipIconStyle(icon: string) {
	return { '--chip-icon': `url("/images/icons/${icon}.svg")` }
}

export async function homeRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const [onboarding, codeRuns, authConfig] = await Promise.all([
		fetchOnboardingPayload(signal),
		fetchCodeRunsPayload(signal),
		fetchPublicAuthConfig(signal),
	])
	const result: RouteLoaderResult = {}
	if (onboarding) result.onboarding = onboarding
	if (codeRuns) result.codeRuns = codeRuns
	if (authConfig) result.signupMode = authConfig.signupMode
	result.walkthroughHosts = pickWalkthroughHosts()
	return result
}

export function HomeRoute(handle: Handle) {
	let needsOnboarding = false
	let emailVerified = false
	let loggedIn = false
	let discoveryPrompt = ''
	let codeRunsWindow: PublicCodeRunsWindow | null = null
	let onboardingStatus: 'idle' | 'loading' | 'ready' = 'idle'
	let walkthroughHosts: WalkthroughHostPick | null = null
	let signupMode: SignupMode = 'invite'
	const loadLatch = createRouteLoadLatch()

	function applyOnboardingPayload(payload: OnboardingPayload | null) {
		needsOnboarding = payload?.needsOnboarding === true
		emailVerified = payload?.emailVerified === true
		loggedIn = payload?.loggedIn === true
		discoveryPrompt = payload?.discoveryPrompt ?? ''
		onboardingStatus = 'ready'
	}

	function applyCodeRunsPayload(
		payload: { window: PublicCodeRunsWindow | null } | null,
	) {
		if (!payload) return
		codeRunsWindow = payload.window
	}

	async function loadHomePayload(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const [payload, codeRuns, authConfig] = await Promise.all([
				fetchOnboardingPayload(signal),
				fetchCodeRunsPayload(signal),
				fetchPublicAuthConfig(signal),
			])
			if (signal.aborted) return
			applyOnboardingPayload(payload)
			applyCodeRunsPayload(codeRuns)
			if (authConfig) signupMode = authConfig.signupMode
			if (!walkthroughHosts) walkthroughHosts = pickWalkthroughHosts()
			loadLatch.markLoaded(href)
			handle.update()
		} catch {
			if (signal.aborted) return
			needsOnboarding = false
			onboardingStatus = 'ready'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isHomePath(href)) return false
		const onboardingData = tryConsumeRouteLoaderData(handle, 'onboarding', href)
		const codeRunsData = tryConsumeRouteLoaderData(handle, 'codeRuns', href)
		const hostsData = tryConsumeRouteLoaderData(
			handle,
			'walkthroughHosts',
			href,
		)
		const signupModeData = tryConsumeRouteLoaderData(handle, 'signupMode', href)
		if (hostsData) walkthroughHosts = hostsData
		if (codeRunsData) applyCodeRunsPayload(codeRunsData)
		if (signupModeData) signupMode = signupModeData
		if (!onboardingData) return false
		applyOnboardingPayload(onboardingData)
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
			onboardingStatus = 'loading'
			handle.queueTask(loadHomePayload)
		}

		const isSignedIn = onboardingStatus === 'ready' && loggedIn
		const needsEmailVerification =
			isSignedIn && needsOnboarding && !emailVerified

		return (
			<div>
				<section data-parallax-scope class="landing-hero">
					<h1 data-rise style={{ '--rise': '0' }} class="landing-hero-title">
						The Home Your Agents <em>Share</em>
					</h1>
					<p data-rise style={{ '--rise': '1' }} class="landing-hero-sub">
						For all the agents you use today,
						<br />
						and the ones you&apos;ll use tomorrow
					</p>
					<LandingHeroAgents hosts={walkthroughHosts ?? undefined} />
					{codeRunsWindow ? <CodeRunsTicker window={codeRunsWindow} /> : null}
					<div data-rise style={{ '--rise': '2' }} class="landing-hero-actions">
						{isSignedIn ? (
							<>
								{needsEmailVerification ? (
									<a href={pendingVerificationPath} class="landing-pill">
										Verify your email
									</a>
								) : (
									<a href={onboardingPath} class="landing-pill">
										Connect your agent
									</a>
								)}
								<a href="/account" class="landing-code-link">
									Open your account
								</a>
							</>
						) : signupMode === 'open' ? (
							<>
								<a href={homepageSignupPath} class="landing-pill">
									Create a free account
								</a>
								<a href="/login" class="landing-code-link">
									I already have an account
								</a>
							</>
						) : (
							<>
								<a href="#invite" class="landing-pill">
									Join the waiting list
								</a>
								<a href={homepageSignupPath} class="landing-code-link">
									I have a code
								</a>
							</>
						)}
					</div>
					<p
						data-rise
						style={{ '--rise': '3' }}
						class="landing-hero-hint landing-hero-hint-lead"
					>
						Not sure yet? Ask the agent you already use whether Kody would help.
						No account necessary.
					</p>
					{discoveryPrompt ? (
						<div
							data-rise
							style={{ '--rise': '3.2' }}
							class="landing-hero-hint"
						>
							<CopyTextButton
								value={discoveryPrompt}
								idleLabel="Copy the discovery prompt"
								variant="ghost"
								size="sm"
							/>
						</div>
					) : null}
				</section>

				<section aria-labelledby="pitch-title" class="landing-pitch">
					<h2 id="pitch-title" class="landing-pitch-title">
						Nothing new <br />
						to learn
					</h2>
					<div>
						<p class="landing-pitch-lead">
							Kody isn&apos;t another assistant to talk to. It plugs into the
							agent you already use, so the same conversation you&apos;re having
							today can now reach your real accounts.
						</p>
						<p class="landing-pitch-body">
							Because your agent does the thinking,{' '}
							<strong>Kody gets better every time your agent does.</strong>
						</p>
					</div>
				</section>

				<section aria-labelledby="factory-title" class="landing-factory">
					<h2 id="factory-title" class="landing-section-heading">
						From ad hoc prompts to durable software
					</h2>
					<p class="landing-factory-lead">
						Stop burning your tokens on the same thing over and over again. Turn
						any process into durable software you can trigger on a schedule,
						notification, or anything else without expensive inference.
					</p>
					<img
						{...landingArtAttrs('kody-compounding-capabilities')}
						alt="Kody tending glowing package pods on a small plant"
						class="landing-factory-art"
						mix={reveal()}
					/>
					<p class="landing-factory-beat-trigger landing-factory-kicker">
						For example
					</p>
					<div class="landing-factory-beats">
						{factoryBeats.map((beat, index) => (
							<article
								key={beat.title}
								class="landing-factory-beat"
								mix={reveal(index * 90)}
							>
								<p class="landing-factory-beat-trigger">{beat.trigger}</p>
								<h3>{beat.title}</h3>
								<p>{beat.copy}</p>
							</article>
						))}
					</div>
					<p class="landing-factory-close">
						Kody has the primitives for your agent to build you{' '}
						<strong>pretty much anything</strong>. What will{' '}
						<strong>you</strong> build?
					</p>
					<section
						aria-labelledby="walkthrough-title"
						class="landing-walkthrough-story"
					>
						<h2
							id="walkthrough-title"
							class="landing-section-heading landing-walkthrough-heading"
						>
							Watch some example conversations
						</h2>
						{walkthroughHosts ? (
							<div class="landing-walkthrough-intro">
								<WalkthroughHostIntro
									variant="picker"
									hosts={walkthroughHosts}
									onHostsChange={(next) => {
										walkthroughHosts = next
										handle.update()
									}}
								/>
							</div>
						) : null}
						<LandingLoopPlayer hosts={walkthroughHosts ?? undefined} />
					</section>
				</section>

				<section
					aria-labelledby="testimonials-title"
					class="landing-testimonials"
				>
					<h2 id="testimonials-title" class="landing-section-heading">
						What early builders say
					</h2>
					<p class="landing-testimonials-lead">
						A few notes from people already putting Kody to work with the agents
						they use every day.
					</p>
					<LandingTestimonialsCarousel />
				</section>

				<section aria-labelledby="honest-title" class="landing-honest">
					<h2 id="honest-title" class="landing-section-heading">
						The agent reasons.
						<br />
						Kody keeps it <em>honest</em>.
					</h2>
					<p class="landing-honest-lead">
						Your agent does the thinking. Kody holds the result so it does not
						have to think it again.
					</p>
					<dl class="landing-honest-rows">
						{honestRows.map((row, index) => (
							<div
								key={row.from}
								class="landing-honest-row"
								mix={reveal(index * 70)}
							>
								<dt>{row.from}</dt>
								<dd>{row.to}</dd>
							</div>
						))}
					</dl>
				</section>

				<section aria-labelledby="ecosystem-title" class="landing-ecosystem">
					<div>
						<h2 id="ecosystem-title" class="landing-section-heading">
							Your own git and npm.
						</h2>
						<p class="landing-split-copy">
							Kody gives you a <strong>personal software ecosystem</strong>.
							Your agent creates repositories and publishes packages, all in
							your own isolated environment. You can also publish your package
							to the community to allow others to fork and you can even use
							public packages on npm as well!
						</p>
						<p class="landing-split-copy">
							Then your agents can use your packages to streamline ad hoc work
							or you can trigger a package to execute in response to a webhook,
							cron, authenticated HTTP call, or even a Kody-hosted application.
						</p>
					</div>
					<img
						{...landingArtAttrs('kody-community-packages')}
						alt="Kody handing a wrapped package across a counter of neatly sorted parcels"
						class="landing-ecosystem-art"
						mix={reveal()}
					/>
				</section>

				<section aria-labelledby="byok-title" class="landing-byok">
					<img
						{...landingArtAttrs('kody-keys')}
						alt="Kody holding up a set of golden keys"
						class="landing-byok-art"
						mix={reveal()}
					/>
					<div>
						<h2 id="byok-title" class="landing-section-heading">
							Bring your own keys
						</h2>
						<p class="landing-split-copy">
							<strong>Keys the agent never sees.</strong> You create the
							connection yourself, with your agent walking you through it: your
							app, your scopes, revocable anytime. Secrets never enter the
							prompt (as opposed to the .env file your agent happily reads).
						</p>
						<p class="landing-split-copy">
							Need your own scopes, or a provider we don&apos;t host? Your agent
							registers the app with you. No shared app sits between you and
							your accounts.
						</p>
					</div>
				</section>

				<section aria-labelledby="world-title" class="landing-world">
					<h2 id="world-title" class="landing-section-heading">
						It already speaks your stack
					</h2>
					<p class="landing-world-lead">
						Community packages cover the tools you live in. Browse what other
						people built, fork it with your agent, and make it yours.
					</p>
					<ul
						aria-label="Services covered by community packages"
						class="landing-world-cloud"
					>
						{worldBrands.map((brand, index) => (
							<li
								key={brand.label}
								class="landing-chip landing-chip-icon"
								style={chipIconStyle(brand.icon)}
								mix={revealPop(index * 35)}
							>
								{brand.label}
							</li>
						))}
						<li
							class="landing-chip landing-chip-muted"
							mix={revealPop(worldBrands.length * 35)}
						>
							…and one thermostat
						</li>
					</ul>
				</section>

				<section aria-labelledby="trust-title" class="landing-trust">
					<h2 id="trust-title" class="landing-section-heading">
						Check out Kody&apos;s Source on GitHub
					</h2>
					<p>
						Kody&apos;s{' '}
						<a
							href="https://github.com/kentcdodds/kody"
							target="_blank"
							rel="noreferrer noopener"
							class="landing-inline-link"
						>
							source is open
						</a>{' '}
						— read it, fork it, self-host it.
					</p>
				</section>

				<section
					id="invite"
					aria-labelledby="invite-title"
					class="landing-invite"
				>
					<img
						{...landingArtAttrs('kody-greeting')}
						alt="Kody waving hello with an open hand"
						class="landing-invite-art"
					/>
					<h2
						id="invite-title"
						class="landing-section-heading landing-invite-title"
					>
						Make it permanent
					</h2>
					{isSignedIn ? (
						<div>
							<p class="landing-invite-lead">
								You&apos;re in. Connect the agent you already use and start
								saving packages.
							</p>
							<p class="landing-invite-cta">
								<a href={onboardingPath} class="landing-pill">
									Connect your agent
								</a>
							</p>
						</div>
					) : signupMode === 'open' ? (
						<div>
							<p class="landing-invite-lead">
								Create a free account and connect the agent you already use.
							</p>
							<p class="landing-invite-cta">
								<a href={homepageSignupPath} class="landing-pill">
									Create a free account
								</a>
							</p>
						</div>
					) : (
						<>
							<p class="landing-invite-lead">
								Invite-only while we grow the eucalyptus. Join the waiting list,
								or jump the queue with a code.
							</p>
							<WaitlistForm />
							<p class="landing-invite-code">
								<a href={homepageSignupPath} class="landing-code-link">
									I have a code
								</a>
							</p>
						</>
					)}
				</section>
			</div>
		)
	}
}

/**
 * Connected-pill waitlist form (name · divider · email · button) with an
 * inline success swap. Posts to the real `/waiting-list` endpoint with the
 * same honeypot + Turnstile protection as the signup page. The challenge
 * script stays off first paint: it loads once the form is near the viewport.
 */
function WaitlistForm(handle: Handle) {
	type Status = 'idle' | 'submitting' | 'success' | 'error'
	let status: Status = 'idle'
	let message: string | null = null
	let protectionArmed = false
	let turnstileSiteKey: string | null | undefined
	let widgetReady = false

	async function loadProtectionConfig(signal: AbortSignal) {
		if (turnstileSiteKey !== undefined) return
		const config = await fetchPublicAuthConfig(signal)
		if (signal.aborted) return
		turnstileSiteKey = config?.turnstileSiteKey ?? null
		handle.update()
	}

	function setState(nextStatus: Status, nextMessage: string | null = null) {
		status = nextStatus
		message = nextMessage
		handle.update()
	}

	function waitingForProtection() {
		if (!protectionArmed) return true
		if (turnstileSiteKey === undefined) return true
		return Boolean(turnstileSiteKey) && !widgetReady
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (status === 'submitting') return
		if (waitingForProtection()) return
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget

		const formData = new FormData(form)
		const firstName = String(formData.get('firstName') ?? '').trim()
		const email = String(formData.get('email') ?? '').trim()
		const protection = readPublicFormProtection(formData)

		if (!firstName) {
			setState('error', 'What should we call you?')
			form.querySelector<HTMLInputElement>('input[name="firstName"]')?.focus()
			return
		}
		// Stricter than type=email alone: require a TLD so "you@example"
		// bounces here, not at the server.
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
			setState('error', "That email doesn't look complete. Mind checking it?")
			form.querySelector<HTMLInputElement>('input[name="email"]')?.focus()
			return
		}

		setState('submitting')

		try {
			const response = await fetch('/waiting-list', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ firstName, email, ...protection }),
			})
			const payload = await response.json().catch(() => null)

			if (!response.ok) {
				const errorMessage =
					typeof payload?.error === 'string'
						? payload.error
						: 'Unable to join the waiting list.'
				// The form stays mounted for another try, and the token it
				// carries has already been spent server-side.
				resetTurnstileWidgets()
				setState('error', errorMessage)
				return
			}

			const successMessage =
				typeof payload?.message === 'string'
					? payload.message
					: "You're on the list. We'll be in touch."
			setState('success', successMessage)
			// Success replaces the fields — including the submit button that
			// currently holds focus — so focus has to be placed deliberately
			// or it falls back to the top of the document.
			handle.queueTask(() => {
				form.querySelector<HTMLElement>('[data-waitlist-success]')?.focus()
			})
		} catch {
			resetTurnstileWidgets()
			setState('error', 'Network error. Please try again.')
		}
	}

	return () => {
		if (typeof document !== 'undefined' && protectionArmed) {
			if (turnstileSiteKey === undefined) {
				handle.queueTask(loadProtectionConfig)
			} else if (turnstileSiteKey) {
				handle.queueTask(async () => {
					try {
						await renderTurnstileWidgets(turnstileSiteKey ?? null)
					} catch {
						// Load/render failure must not pin the submit button
						// disabled. A later POST can still surface the server
						// error the way the immediate-load waitlist did.
					}
					if (widgetReady) return
					widgetReady = true
					handle.update()
				})
			}
		}
		const isSubmitting = status === 'submitting'
		const protectionPending = waitingForProtection()
		const submitDisabled = isSubmitting || protectionPending

		return (
			<form
				noValidate
				class="landing-waitlist"
				mix={[
					on('submit', handleSubmit),
					ref((node, signal) => {
						const stop = observeNearViewport(node, () => {
							if (protectionArmed) return
							protectionArmed = true
							handle.update()
						})
						signal.addEventListener('abort', stop, { once: true })
					}),
				]}
			>
				{/*
				 * A live region only announces text that changes while the
				 * region is already in the accessibility tree, so the announcer
				 * stays mounted for the life of the form. Success is left out:
				 * that state unmounts the submit button, so focus moves to the
				 * confirmation instead, which announces it once.
				 */}
				<p role="status" class="visually-hidden">
					{status === 'success' ? '' : (message ?? '')}
				</p>
				{status === 'success' ? (
					<p tabindex={-1} data-waitlist-success class="landing-form-success">
						{message}{' '}
						<button
							type="button"
							class="landing-form-reset"
							mix={on('click', () => {
								setState('idle')
								handle.queueTask(() => {
									document.getElementById(`${handle.id}-email`)?.focus()
								})
							})}
						>
							Wrong email?
						</button>
					</p>
				) : (
					<>
						<div data-focus-container class="landing-waitlist-fields">
							<input
								type="text"
								name={honeypotFieldName}
								tabIndex={-1}
								autoComplete="off"
								aria-hidden="true"
								class="visually-hidden landing-honeypot"
							/>
							<label for={`${handle.id}-name`} class="visually-hidden">
								First name
							</label>
							<input
								id={`${handle.id}-name`}
								type="text"
								name="firstName"
								required
								maxLength={80}
								placeholder="First name"
								autoComplete="given-name"
								class="landing-waitlist-input"
							/>
							<label for={`${handle.id}-email`} class="visually-hidden">
								Email address
							</label>
							<input
								id={`${handle.id}-email`}
								type="email"
								name="email"
								required
								placeholder="you@yourdomain.dev"
								autoComplete="email"
								class="landing-waitlist-input landing-waitlist-email"
							/>
							<button
								type="submit"
								aria-disabled={submitDisabled ? 'true' : undefined}
								aria-busy={isSubmitting ? 'true' : undefined}
								class="landing-pill landing-pill-swap"
							>
								<span
									data-swap-label
									data-active={isSubmitting ? undefined : 'true'}
									aria-hidden={isSubmitting ? 'true' : undefined}
								>
									Join the waiting list
								</span>
								<span
									data-swap-label
									data-active={isSubmitting ? 'true' : undefined}
									aria-hidden={isSubmitting ? undefined : 'true'}
								>
									Joining…
								</span>
							</button>
						</div>
						{protectionArmed && turnstileSiteKey ? (
							<div class={turnstileWidgetClassName}></div>
						) : null}
						{status === 'error' && message ? (
							// Announced by the mounted live region above.
							<p aria-hidden="true" class="landing-form-error">
								{message}
							</p>
						) : null}
					</>
				)}
			</form>
		)
	}
}
