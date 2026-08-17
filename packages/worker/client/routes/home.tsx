import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { HeroStage } from '#client/hero-stage.tsx'
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
import { reveal, revealPop } from '#client/reveal.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import {
	honeypotFieldName,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import { routes } from '#universal/routes.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	getBrandChipCss,
	getLanternGlowCss,
	getPillButtonCss,
	getSwapLabelCss,
	hoverMq,
	layoutMaxWidths,
	mergeCss,
	sectionHeadingCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

/**
 * heykody.app landing page, ported from the redesign prototype
 * (`landing/landing.html`). Flat neutral canvas, one vibrant green accent,
 * centered single-column flow, mascot illustrations doing the explanatory
 * work. Motion is enhance-only (`html.js`) and fully off under
 * `prefers-reduced-motion`.
 *
 * Positioning: permanence / personal software factory — not "equip your
 * agent." Factory-loop art reuses the existing 3D set; do not generate a
 * new koala.
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

const hostAgents = [
	{ label: 'Cursor', icon: 'cursor' },
	{ label: 'Claude Code', icon: 'claudecode' },
	{ label: 'ChatGPT', icon: 'chatgpt' },
	{ label: 'Copilot', icon: 'githubcopilot' },
	{ label: 'Claude', icon: 'claude' },
	{ label: 'Grok', icon: 'grok' },
	{ label: 'Grok Bot', icon: 'grokbot' },
	{ label: 'OpenCode', icon: 'opencode' },
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

export async function homeRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const onboarding = await fetchOnboardingPayload(signal)
	if (!onboarding) return {}
	return { onboarding }
}

export function HomeRoute(handle: Handle) {
	let needsOnboarding = false
	let emailVerified = false
	let loggedIn = false
	let discoveryPrompt = ''
	let onboardingStatus: 'idle' | 'loading' | 'ready' = 'idle'
	const loadLatch = createRouteLoadLatch()

	function applyOnboardingPayload(payload: OnboardingPayload | null) {
		needsOnboarding = payload?.needsOnboarding === true
		emailVerified = payload?.emailVerified === true
		loggedIn = payload?.loggedIn === true
		discoveryPrompt = payload?.discoveryPrompt ?? ''
		onboardingStatus = 'ready'
	}

	async function loadOnboarding(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const payload = await fetchOnboardingPayload(signal)
			if (signal.aborted) return
			applyOnboardingPayload(payload)
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
		const routeData = tryConsumeRouteLoaderData(handle, 'onboarding', href)
		if (!routeData) return false
		applyOnboardingPayload(routeData)
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
			handle.queueTask(loadOnboarding)
		}

		const isSignedIn = onboardingStatus === 'ready' && loggedIn
		const needsEmailVerification =
			isSignedIn && needsOnboarding && !emailVerified

		return (
			<div>
				{/* ============ hero ============ */}
				<section data-parallax-scope mix={css(heroCss)}>
					<h1 data-rise style={{ '--rise': '0' }} mix={css(heroTitleCss)}>
						Kody makes your agent
						<br />
						<em>safer, cheaper,</em>{' '}
						<span mix={css(heroBenefitsRestCss)}>
							and more <em>reliable</em>.
						</span>
					</h1>
					<p data-rise style={{ '--rise': '1' }} mix={css(heroSubCss)}>
						A personal <strong>software factory</strong>. Turn the ad hoc agent
						work into deterministic code you can run on a trigger or save tokens
						with your agent.
					</p>
					<div data-rise style={{ '--rise': '2' }} mix={css(heroActionsCss)}>
						{isSignedIn ? (
							<>
								{needsEmailVerification ? (
									<a href={pendingVerificationPath} mix={css(pillButtonCss)}>
										Verify your email
									</a>
								) : (
									<a href={onboardingPath} mix={css(pillButtonCss)}>
										Connect your agent
									</a>
								)}
								<a href="/account" mix={css(codeLinkCss)}>
									Open your account
								</a>
							</>
						) : (
							<>
								<a href="#invite" mix={css(pillButtonCss)}>
									Join the waiting list
								</a>
								<a href="/signup" mix={css(codeLinkCss)}>
									I have a code
								</a>
							</>
						)}
					</div>
					<p data-rise style={{ '--rise': '3' }} mix={css(heroHintLeadCss)}>
						Not sure yet? Ask the agent you already use whether Kody would help.
						No account necessary.
					</p>
					{discoveryPrompt ? (
						<div data-rise style={{ '--rise': '3.2' }} mix={css(heroHintCss)}>
							<CopyTextButton
								value={discoveryPrompt}
								idleLabel="Copy the discovery prompt"
								variant="ghost"
								size="sm"
							/>
						</div>
					) : null}
					<h2 data-rise style={{ '--rise': '3.4' }} mix={css(heroMeetCss)}>
						Meet Kody
					</h2>
					<div data-rise style={{ '--rise': '1.5' }} mix={css(heroArtCss)}>
						<HeroStage
							size="landing"
							alt="Kody the koala holding a warmly glowing lantern, surrounded by floating notes, bookmarks, packages, and tool tokens"
						/>
					</div>
				</section>

				{/* ============ nothing new to learn ============ */}
				<section aria-labelledby="pitch-title" mix={css(pitchCss)}>
					<h2 id="pitch-title" mix={css(pitchTitleCss)}>
						Nothing new <br />
						to learn
					</h2>
					<div>
						<p mix={css(pitchLeadCss)}>
							Kody isn&apos;t another assistant to talk to. It plugs into the
							agent you already use, so the same conversation you&apos;re having
							today can now reach your real accounts.
						</p>
						<p mix={css(pitchBodyCss)}>
							Because your agent does the thinking,{' '}
							<strong>Kody gets better every time your agent does.</strong>
						</p>
						<ul aria-label="Agents Kody plugs into" mix={css(pitchHostsCss)}>
							{hostAgents.map((agent, index) => (
								<li
									key={agent.label}
									mix={[
										css(getHostChipCss(`/images/icons/${agent.icon}.svg`)),
										revealPop(index * 35),
									]}
								>
									{agent.label}
								</li>
							))}
							<li
								mix={[css(hostsMoreChipCss), revealPop(hostAgents.length * 35)]}
							>
								anything that speaks MCP
							</li>
						</ul>
					</div>
				</section>

				{/* ============ factory loop ============ */}
				<section aria-labelledby="factory-title" mix={css(factoryCss)}>
					<h2 id="factory-title" mix={css(sectionHeadingCss)}>
						From ad hoc prompts to durable software
					</h2>
					<p mix={css(factoryLeadCss)}>
						Stop burning your tokens on the same thing over and over again. Turn
						any process into durable software you can trigger on a schedule,
						notification, or anything else without expensive inference.
					</p>
					<img
						src="/images/kody-compounding-capabilities.webp"
						width={480}
						height={480}
						loading="lazy"
						alt="Kody tending glowing package pods on a small plant"
						mix={[css(factoryArtCss), reveal()]}
					/>
					<p mix={css(factoryExamplesKickerCss)}>For example</p>
					<div mix={css(factoryBeatsCss)}>
						{factoryBeats.map((beat, index) => (
							<article
								key={beat.title}
								mix={[css(factoryBeatCss), reveal(index * 90)]}
							>
								<p mix={css(factoryBeatTriggerCss)}>{beat.trigger}</p>
								<h3>{beat.title}</h3>
								<p>{beat.copy}</p>
							</article>
						))}
					</div>
					<p mix={css(factoryCloseCss)}>
						Kody has the primitives for your agent to build you{' '}
						<strong>pretty much anything</strong>. What will{' '}
						<strong>you</strong> build?
					</p>
					<p mix={css(factoryWalkthroughCss)}>
						<a href={routes.guideDetail.href({ slug: 'how-kody-works' })}>
							See the whole loop
						</a>
					</p>
				</section>

				{/* ============ git + npm ecosystem ============ */}
				<section aria-labelledby="ecosystem-title" mix={css(ecosystemCss)}>
					<div>
						<h2 id="ecosystem-title" mix={css(sectionHeadingCss)}>
							Your own git and npm.
						</h2>
						<p mix={css(splitCopyCss)}>
							Kody gives you a <strong>personal software ecosystem</strong>.
							Your agent creates repositories and publishes packages, all in
							your own isolated environment. You can also publish your package
							to the community to allow others to fork and you can even use
							public packages on npm as well!
						</p>
						<p mix={css(splitCopyCss)}>
							Then your agents can use your packages to streamline ad hoc work
							or you can trigger a package to execute in response to a webhook,
							cron, authenticated HTTP call, or even a Kody-hosted application.
						</p>
					</div>
					<img
						src="/images/kody-community-packages.webp"
						width={480}
						height={480}
						loading="lazy"
						alt="Kody handing a wrapped package across a counter of neatly sorted parcels"
						mix={[css(ecosystemArtCss), reveal()]}
					/>
				</section>

				{/* ============ byok ============ */}
				<section aria-labelledby="byok-title" mix={css(byokCss)}>
					<img
						src="/images/kody-keys.webp"
						width={480}
						height={480}
						loading="lazy"
						alt="Kody holding up a set of golden keys"
						mix={[css(byokArtCss), reveal()]}
					/>
					<div>
						<h2 id="byok-title" mix={css(sectionHeadingCss)}>
							Bring your own keys
						</h2>
						<p mix={css(splitCopyCss)}>
							<strong>Keys the agent never sees.</strong> You create the
							connection yourself, with your agent walking you through it: your
							app, your scopes, revocable anytime. Secrets never enter the
							prompt (as opposed to the .env file your agent happily reads).
						</p>
						<p mix={css(splitCopyCss)}>
							A few built-in integrations are one-click for simple cases. Need
							your own scopes, or a provider we don&apos;t host? Your agent
							registers the app with you. No shared app sits between you and
							your accounts.
						</p>
					</div>
				</section>

				{/* ============ works with ============ */}
				<section aria-labelledby="world-title" mix={css(worldCss)}>
					<h2 id="world-title" mix={css(sectionHeadingCss)}>
						It already speaks your stack
					</h2>
					<p mix={css(worldLeadCss)}>
						Community packages cover the tools you live in. Browse what other
						people built, fork it with your agent, and make it yours.
					</p>
					<ul
						aria-label="Services covered by community packages"
						mix={css(worldCloudCss)}
					>
						{worldBrands.map((brand, index) => (
							<li
								key={brand.label}
								mix={[
									css(
										getBrandChipCss({
											iconHref: `/images/icons/${brand.icon}.svg`,
										}),
									),
									revealPop(index * 35),
								]}
							>
								{brand.label}
							</li>
						))}
						<li
							mix={[
								css(getBrandChipCss({ muted: true })),
								revealPop(worldBrands.length * 35),
							]}
						>
							…and one thermostat
						</li>
					</ul>
				</section>

				{/* ============ trust ============ */}
				<section aria-labelledby="trust-title" mix={css(trustCss)}>
					<h2 id="trust-title" mix={css(sectionHeadingCss)}>
						Check out Kody&apos;s Source on GitHub
					</h2>
					<p>
						Kody&apos;s{' '}
						<a
							href="https://github.com/kentcdodds/kody"
							target="_blank"
							rel="noreferrer noopener"
							mix={css(inlineLinkCss)}
						>
							source is open
						</a>{' '}
						— read it, fork it, self-host it.
					</p>
				</section>

				{/* ============ closing invite ============ */}
				<section id="invite" aria-labelledby="invite-title" mix={css(equipCss)}>
					<img
						src="/images/kody-greeting.webp"
						width={480}
						height={480}
						loading="lazy"
						alt="Kody waving hello with an open hand"
						mix={css(equipArtCss)}
					/>
					<h2 id="invite-title" mix={css(equipTitleCss)}>
						Make it permanent
					</h2>
					{isSignedIn ? (
						<div>
							<p mix={css(equipLeadCss)}>
								You&apos;re in. Connect the agent you already use and start
								saving packages.
							</p>
							<p mix={css({ margin: '1.8rem auto 0' })}>
								<a href={onboardingPath} mix={css(pillButtonCss)}>
									Connect your agent
								</a>
							</p>
						</div>
					) : (
						<>
							<p mix={css(equipLeadCss)}>
								Invite-only while we grow the eucalyptus. Join the waiting list,
								or jump the queue with a code.
							</p>
							<WaitlistForm />
							<p mix={css(equipCodeCss)}>
								<a href="/signup" mix={css(codeLinkFooterCss)}>
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
 * same honeypot + Turnstile protection as the signup page.
 */
function WaitlistForm(handle: Handle) {
	type Status = 'idle' | 'submitting' | 'success' | 'error'
	let status: Status = 'idle'
	let message: string | null = null
	let turnstileSiteKey: string | null | undefined

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

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (status === 'submitting') return
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
		if (typeof document !== 'undefined' && turnstileSiteKey === undefined) {
			handle.queueTask(loadProtectionConfig)
		}
		if (typeof document !== 'undefined' && turnstileSiteKey) {
			handle.queueTask(() => renderTurnstileWidgets(turnstileSiteKey ?? null))
		}
		const isSubmitting = status === 'submitting'

		return (
			<form noValidate mix={[css(waitlistFormCss), on('submit', handleSubmit)]}>
				{/*
				 * A live region only announces text that changes while the
				 * region is already in the accessibility tree, so the announcer
				 * stays mounted for the life of the form. Success is left out:
				 * that state unmounts the submit button, so focus moves to the
				 * confirmation instead, which announces it once.
				 */}
				<p role="status" mix={css(visuallyHiddenCss)}>
					{status === 'success' ? '' : (message ?? '')}
				</p>
				{status === 'success' ? (
					<p tabindex={-1} data-waitlist-success mix={css(formSuccessCss)}>
						{message}{' '}
						<button
							type="button"
							mix={[
								css(formResetCss),
								on('click', () => {
									setState('idle')
									handle.queueTask(() => {
										document.getElementById(`${handle.id}-email`)?.focus()
									})
								}),
							]}
						>
							Wrong email?
						</button>
					</p>
				) : (
					<>
						<div data-focus-container mix={css(waitlistFieldsCss)}>
							<input
								type="text"
								name={honeypotFieldName}
								tabIndex={-1}
								autoComplete="off"
								aria-hidden="true"
								mix={css(honeypotCss)}
							/>
							<label for={`${handle.id}-name`} mix={css(visuallyHiddenCss)}>
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
								mix={css(waitlistInputCss)}
							/>
							<label for={`${handle.id}-email`} mix={css(visuallyHiddenCss)}>
								Email address
							</label>
							<input
								id={`${handle.id}-email`}
								type="email"
								name="email"
								required
								placeholder="you@yourdomain.dev"
								autoComplete="email"
								mix={css(waitlistEmailInputCss)}
							/>
							<button
								type="submit"
								aria-disabled={isSubmitting ? 'true' : undefined}
								aria-busy={isSubmitting ? 'true' : undefined}
								mix={css(waitlistSubmitCss)}
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
						{turnstileSiteKey ? (
							<div class={turnstileWidgetClassName}></div>
						) : null}
						{status === 'error' && message ? (
							// Announced by the mounted live region above.
							<p aria-hidden="true" mix={css(formErrorCss)}>
								{message}
							</p>
						) : null}
					</>
				)}
			</form>
		)
	}
}

/* ---------- styles ---------- */

const sectionGutter = 'clamp(1.25rem, 4vw, 2.5rem)'
const motionOk = '@media (prefers-reduced-motion: no-preference)'

const inlineLinkCss = {
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	'&:hover': { color: colors.text },
}

const pillButtonCss = getPillButtonCss()

/* The submit pill keeps both labels grid-stacked in one cell, so swapping to
   "Joining…" never changes the button's size — the swap is a blur crossfade. */
const waitlistSubmitCss = mergeCss(getPillButtonCss(), getSwapLabelCss(), {
	'&[aria-disabled="true"]': {
		cursor: 'progress',
		opacity: 0.7,
		transform: 'none',
	},
	[hoverMq]: {
		'&[aria-disabled="true"]:hover, &[aria-disabled="true"]:active': {
			transform: 'none',
			boxShadow: 'none',
		},
	},
})

const codeLinkCss = {
	...inlineLinkCss,
	fontWeight: 600,
}

const codeLinkFooterCss = codeLinkCss

/* ---------- hero ---------- */

const heroCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(3.5rem, 8vw, 6.5rem) ${sectionGutter} 0`,
	textAlign: 'center' as const,
}

const heroTitleCss = {
	margin: 0,
	fontSize: 'clamp(2.7rem, 6.5vw, 5rem)',
	fontWeight: 760,
	lineHeight: 1.02,
	letterSpacing: '-0.03em',
	fontVariationSettings: '"opsz" 96',
	'& em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
}

const heroBenefitsRestCss = {
	whiteSpace: 'nowrap' as const,
}

const heroSubCss = {
	margin: '1.5rem auto 0',
	fontSize: 'clamp(1.05rem, 1.6vw, 1.2rem)',
	color: colors.textMuted,
	maxWidth: '56ch',
	textWrap: 'pretty' as const,
	'& strong': {
		fontWeight: 700,
		color: colors.text,
	},
}

const heroActionsCss = {
	marginTop: '2.2rem',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.8rem 1.6rem',
}

const heroHintCss = {
	margin: '1.1rem auto 0',
	fontSize: '0.95rem',
	color: colors.textMuted,
	maxWidth: '52ch',
	textWrap: 'pretty' as const,
}

const heroHintLeadCss = {
	...heroHintCss,
	marginTop: '2rem',
}

const heroMeetCss = {
	margin: 'clamp(2.5rem, 5vw, 4rem) 0 0',
	fontSize: 'clamp(2.2rem, 5vw, 4rem)',
	fontWeight: 740,
	letterSpacing: '-0.03em',
	lineHeight: 1.04,
}

const heroArtCss = {
	marginTop: '0.85rem',
	position: 'relative' as const,
	/* See `pageHeadCss`: the fabric is a backdrop, so it paints under the art. */
	isolation: 'isolate' as const,
	/* Kody's shirt fabric, at whisper contrast behind him. The radial gradient
	   fades it out so it never reads as a tiled wallpaper edge. */
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: '-6% -18%',
		background: `radial-gradient(closest-side, oklch(from ${colors.text} l c h / 0.07), transparent 74%)`,
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
	...getLanternGlowCss({ maxWidth: '230px' }),
}

/* ---------- pitch ---------- */

const pitchCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(4rem, 9vw, 7.5rem) ${sectionGutter} clamp(2rem, 4vw, 3rem)`,
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr)',
	gap: 'clamp(2rem, 5vw, 4.5rem)',
	alignItems: 'start',
	'@media (max-width: 800px)': {
		gridTemplateColumns: '1fr',
		textAlign: 'center' as const,
		padding: '3.25rem 1.25rem 1.75rem',
	},
}

const pitchTitleCss = {
	margin: 0,
	fontSize: 'clamp(2rem, 4.2vw, 3.2rem)',
	fontWeight: 740,
	letterSpacing: '-0.026em',
	lineHeight: 1.04,
	'@media (max-width: 800px)': {
		fontSize: '2rem',
		'& br': { display: 'none' },
	},
}

const pitchLeadCss = {
	margin: 0,
	fontSize: 'clamp(1.15rem, 1.8vw, 1.35rem)',
	lineHeight: 1.5,
	color: colors.text,
	maxWidth: '44ch',
	textWrap: 'pretty' as const,
	'@media (max-width: 800px)': {
		fontSize: '1.125rem',
		marginInline: 'auto',
		maxWidth: '40ch',
	},
}

const pitchBodyCss = {
	margin: '1.2rem 0 0',
	color: colors.textMuted,
	fontSize: '1.05rem',
	maxWidth: '48ch',
	textWrap: 'pretty' as const,
	'& strong': {
		fontWeight: 700,
		color: colors.text,
	},
	'@media (max-width: 800px)': {
		fontSize: '1rem',
		marginInline: 'auto',
		maxWidth: '46ch',
	},
}

const pitchHostsCss = {
	listStyle: 'none',
	margin: '1.8rem 0 0',
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.6rem',
	'@media (max-width: 800px)': {
		justifyContent: 'center',
	},
}

function getHostChipCss(iconHref: string) {
	return {
		...getBrandChipCss({ iconHref }),
		fontSize: '0.92rem',
		padding: '0.4rem 0.95rem',
	}
}

const hostsMoreChipCss = {
	...getBrandChipCss({ muted: true }),
	fontSize: '0.92rem',
	padding: '0.4rem 0.95rem',
}

/* ---------- factory loop ---------- */

const factoryCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(2rem, 4vw, 3.5rem) ${sectionGutter}`,
	textAlign: 'center' as const,
	'@media (max-width: 800px)': {
		padding: '1.75rem 1.25rem',
	},
}

const factoryLeadCss = {
	margin: '1.1rem auto 0',
	color: colors.textMuted,
	fontSize: '1.08rem',
	maxWidth: '48ch',
	textWrap: 'pretty' as const,
}

const factoryArtCss = {
	width: 'min(70%, 400px)',
	maxWidth: '100%',
	height: 'auto',
	display: 'block',
	marginInline: 'auto',
	marginTop: 'clamp(1.5rem, 3vw, 2.5rem)',
	'@media (max-width: 800px)': {
		width: 'min(60%, 300px)',
	},
}

const factoryBeatsCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
	gap: 'clamp(1.75rem, 4vw, 2.5rem) clamp(1.5rem, 3vw, 2.5rem)',
	marginTop: '1.15rem',
	textAlign: 'left' as const,
	'@media (max-width: 800px)': {
		textAlign: 'center' as const,
	},
}

const factoryBeatTriggerCss = {
	margin: 0,
	fontSize: '0.78rem',
	fontWeight: 600,
	letterSpacing: '0.12em',
	textTransform: 'uppercase' as const,
	color: colors.primaryText,
}

const factoryExamplesKickerCss = {
	...factoryBeatTriggerCss,
	margin: 'clamp(2rem, 4vw, 3rem) 0 0',
	fontSize: '1.15rem',
}

const factoryBeatCss = {
	'& h3': {
		margin: '0.45rem 0 0',
		fontSize: '1.35rem',
		fontWeight: 700,
		letterSpacing: '-0.015em',
	},
	'& p:last-child': {
		margin: '0.7rem 0 0',
		color: colors.textMuted,
		fontSize: '0.98rem',
		maxWidth: '38ch',
		textWrap: 'pretty' as const,
	},
	'@media (max-width: 800px)': {
		'& p:last-child': {
			fontSize: '1rem',
			maxWidth: '46ch',
			marginInline: 'auto',
		},
	},
}

const factoryCloseCss = {
	margin: 'clamp(2rem, 4vw, 2.75rem) auto 0',
	color: colors.textMuted,
	fontSize: '1.02rem',
	maxWidth: '42ch',
	textWrap: 'balance' as const,
	'& strong': {
		color: colors.text,
		fontWeight: 650,
	},
}

const factoryWalkthroughCss = {
	margin: '0.85rem 0 0',
	'& a': {
		color: colors.primaryText,
		fontWeight: 600,
		textDecoration: 'none',
		'&:hover': {
			textDecoration: 'underline',
		},
	},
}

/* ---------- git + npm + byok splits ---------- */

const ecosystemCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(2rem, 5vw, 4rem) ${sectionGutter}`,
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)',
	gap: 'clamp(2rem, 5vw, 4.5rem)',
	alignItems: 'center',
	'@media (max-width: 800px)': {
		gridTemplateColumns: '1fr',
		textAlign: 'center' as const,
		padding: '1.75rem 1.25rem',
	},
}

const ecosystemArtCss = {
	width: 'min(100%, 400px)',
	maxWidth: '100%',
	height: 'auto',
	display: 'block',
	marginInline: 'auto',
	'@media (max-width: 800px)': {
		order: -1,
		width: 'min(60%, 300px)',
	},
}

const byokCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(2rem, 5vw, 4rem) ${sectionGutter}`,
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr)',
	gap: 'clamp(2rem, 5vw, 4.5rem)',
	alignItems: 'center',
	'@media (max-width: 800px)': {
		gridTemplateColumns: '1fr',
		textAlign: 'center' as const,
		padding: '1.75rem 1.25rem',
	},
}

const byokArtCss = {
	width: 'min(100%, 380px)',
	maxWidth: '100%',
	height: 'auto',
	display: 'block',
	marginInline: 'auto',
	'@media (max-width: 800px)': {
		width: 'min(60%, 300px)',
	},
}

const splitCopyCss = {
	margin: '1.1rem 0 0',
	color: colors.textMuted,
	maxWidth: '48ch',
	textWrap: 'pretty' as const,
	'& strong': {
		fontWeight: 700,
		color: colors.text,
	},
	'@media (max-width: 800px)': {
		fontSize: '1rem',
		marginInline: 'auto',
		maxWidth: '46ch',
	},
}

/* ---------- world ---------- */

const worldCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(3rem, 7vw, 5.5rem) ${sectionGutter} clamp(2rem, 4vw, 3rem)`,
	textAlign: 'center' as const,
	'@media (max-width: 800px)': {
		padding: '3.25rem 1.25rem 1.75rem',
	},
}

const worldLeadCss = {
	margin: '1.1rem auto 0',
	color: colors.textMuted,
	fontSize: '1.08rem',
	maxWidth: '46ch',
	textWrap: 'balance' as const,
}

const worldCloudCss = {
	listStyle: 'none',
	margin: '2.2rem auto 0',
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'center',
	gap: '0.6rem',
	maxWidth: '46rem',
}

/* ---------- trust ---------- */

/* Two quiet receipts before the close: security posture and open source.
   Muted on purpose — these earn trust by not selling. */
const trustCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(1.5rem, 4vw, 2.5rem) ${sectionGutter}`,
	textAlign: 'center' as const,
	display: 'grid',
	gap: '1.1rem',
	justifyItems: 'center',
	'& p': {
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.98rem',
		maxWidth: '58ch',
		textWrap: 'balance' as const,
	},
}

/* ---------- equip / invite ---------- */

const equipCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(2rem, 5vw, 4rem) ${sectionGutter} clamp(4.5rem, 9vw, 7rem)`,
	textAlign: 'center' as const,
	position: 'relative' as const,
	/* See `pageHeadCss`: the fabric is a backdrop, so it paints under the copy. */
	isolation: 'isolate' as const,
	/* Same fabric behind the closing invite: make the work permanent. */
	'&::before': {
		content: '""',
		position: 'absolute' as const,
		zIndex: -1,
		inset: 0,
		background: `radial-gradient(ellipse 55% 50% at 50% 42%, oklch(from ${colors.text} l c h / 0.055), transparent 72%)`,
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
	'@media (max-width: 800px)': {
		padding: '1.75rem 1.25rem 4.5rem',
	},
}

const equipArtCss = {
	width: 'min(62%, 330px)',
	maxWidth: '100%',
	height: 'auto',
	display: 'block',
	marginInline: 'auto',
}

const equipTitleCss = {
	...sectionHeadingCss,
	marginTop: '1.6rem',
	'@media (max-width: 800px)': {
		fontSize: '2rem',
	},
}

const equipLeadCss = {
	margin: '1.1rem auto 0',
	color: colors.textMuted,
	fontSize: '1.08rem',
	maxWidth: '44ch',
	textWrap: 'balance' as const,
	'@media (max-width: 800px)': {
		fontSize: '1rem',
		maxWidth: '46ch',
	},
}

const equipCodeCss = {
	margin: '1.4rem auto 0',
	fontSize: '1rem',
}

/* ---------- waitlist form ---------- */

const waitlistFormCss = {
	position: 'relative' as const,
	display: 'grid',
	gap: '0.9rem',
	width: 'min(100%, 640px)',
	margin: '2rem auto 0',
	textAlign: 'left' as const,
}

/*
 * Pill geometry shared by the container and its segments, so a focused
 * segment's tint nests concentrically inside the container's curve instead of
 * guessing at it.
 */
const waitlistPillRadius = '999px'
const waitlistStackRadius = '28px'
const waitlistPillPadding = '0.3rem'

/* One connected control: name · divider · email · button in a single pill. */
const waitlistFieldsCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 0.75fr) minmax(0, 1fr) auto',
	alignItems: 'stretch',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: waitlistPillRadius,
	padding: waitlistPillPadding,
	transition: `border-color 160ms ${transitions.easeOut}, box-shadow 160ms ${transitions.easeOut}`,
	'&:focus-within': {
		borderColor: colors.primary,
		boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
	},
	'@media (max-width: 640px)': {
		/* The pill relaxes into a stacked segmented control. */
		gridTemplateColumns: '1fr',
		borderRadius: waitlistStackRadius,
		'& button': { width: '100%', marginTop: waitlistPillPadding },
	},
}

const waitlistInputCss = {
	font: `400 1rem/1.2 ${typography.fontFamilyBody}`,
	color: colors.text,
	backgroundColor: 'transparent',
	border: 'none',
	/*
	 * Leading segment of the pill, so it takes the container's inner curve on
	 * its outer edge and stays square where it meets the next segment. A full
	 * `999px` capsule here read as a lozenge floating inside the pill once the
	 * focus tint made the shape visible.
	 */
	borderRadius: `calc(${waitlistPillRadius} - ${waitlistPillPadding}) 0 0 calc(${waitlistPillRadius} - ${waitlistPillPadding})`,
	padding: '0.7rem 1.1rem',
	minWidth: 0,
	'&::placeholder': { color: colors.textMuted, opacity: 1 },
	/*
	 * No background change on focus. Both segments are text inputs, so the
	 * caret already shows which one has focus, and the container's
	 * `:focus-within` ring shows the composite control is focused — together
	 * that is the visible focus indicator. A tint on top of those read as a
	 * lighter slab sitting inside the pill, most obviously in dark mode.
	 */
	'&:focus': { outline: 'none' },
	'@media (max-width: 640px)': {
		paddingBlock: '0.85rem',
		/* Stacked: the leading segment now rounds along the top instead. */
		borderRadius: `calc(${waitlistStackRadius} - ${waitlistPillPadding}) calc(${waitlistStackRadius} - ${waitlistPillPadding}) 0 0`,
	},
}

const waitlistEmailInputCss = {
	...waitlistInputCss,
	borderLeft: `1px solid ${colors.border}`,
	/* Middle segment: square on both sides, between the name and the button. */
	borderRadius: 0,
	'@media (max-width: 640px)': {
		paddingBlock: '0.85rem',
		borderLeft: 'none',
		borderTop: `1px solid ${colors.border}`,
		borderRadius: 0,
	},
}

const formErrorCss = {
	margin: 0,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	textAlign: 'center' as const,
	color: colors.error,
	[motionOk]: {
		animation: 'success-in 250ms var(--ease-out) both',
	},
}

const formSuccessCss = {
	margin: 0,
	fontSize: '0.95rem',
	lineHeight: 1.5,
	textAlign: 'center' as const,
	color: colors.textMuted,
	'& strong': { color: colors.primaryText },
	[motionOk]: {
		animation: 'success-in 250ms var(--ease-out) both',
	},
}

const formResetCss = {
	font: 'inherit',
	background: 'none',
	border: 'none',
	padding: 0,
	color: colors.primaryText,
	textDecoration: 'underline',
	textUnderlineOffset: '3px',
	cursor: 'pointer',
	'&:hover': { color: colors.text },
}

const honeypotCss = {
	...visuallyHiddenCss,
	left: '-10000px',
}
