import { type Handle, type RemixNode } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	createRouteData,
	renderRoutePendingStatus,
} from '#client/route-data.tsx'
import {
	fetchOnboardingPayload,
	type OnboardingPayload,
} from '#client/routes/onboarding-payload.ts'
import { onboardingPath } from '#client/routes/onboarding-redirect.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { reveal, revealPop } from '#client/reveal.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import { landingArtAttrs } from '#universal/landing-images.ts'
import { landingWorldBrands } from '#universal/landing-world-brands.ts'
import { homepageSignupPath } from '#universal/first-touch-attribution.ts'
import {
	landingHeroCopyPromptLabel,
	landingHeroHeadlineAccent,
	landingHeroHeadlineLead,
	landingHeroHeadlineRest,
} from '#universal/landing-hero-copy.ts'
import {
	publicCreateAccountLabel,
	publicHaveCodeLabel,
	publicJoinWaitlistLabel,
} from '#universal/public-signup-copy.ts'
import { parseSignupMode, type SignupMode } from '#universal/signup-mode.ts'
import {
	pickWalkthroughHosts,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import { LandingHeroAgents } from '#client/routes/landing-hero-agents.tsx'
import { LandingByokDemo } from './landing-byok-demo.tsx'
import { LandingTestimonialsCarousel } from './landing-testimonials-carousel.tsx'
import { LandingLoopPlayer } from './landing-loop-player.tsx'
import { WaitlistForm } from './landing-waitlist-form.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'

/**
 * Public landing page, ported from the redesign prototype
 * (`landing/landing.html`). Flat neutral canvas, one vibrant green accent,
 * centered single-column flow, mascot illustrations doing the explanatory
 * work. Motion is enhance-only (`html.js`) and fully off under
 * `prefers-reduced-motion`.
 *
 * Positioning (public door): stop sweating switching agents. The hero stage
 * (Kody with the host agents tethered around it) names the agents; the H1
 * matches the home OG card. Factory / npm / packages stay below the fold.
 * The factory closer is the ritual: ask once, save it, trigger it.
 *
 * Layout styles live in `public/styles.css` (`.landing-*`) so SSR does not
 * emit a per-node `<style data-rmx>` tag for every marketing block.
 */

const factoryBeats = [
	{
		trigger: 'Cron',
		title: 'Flake Hunter',
		icon: 'target',
		copy: 'Nightly scan of yesterday’s CI. Obvious flakes trigger an agent to look into it.',
	},
	{
		trigger: 'Webhook',
		title: 'Sentry Issues',
		icon: 'alert',
		copy: 'A Sentry issue hits the webhook. Your package fingerprints repeats and triggers an agent to triage.',
	},
	{
		trigger: 'Email',
		title: 'Agent inbox',
		icon: 'envelope',
		copy: 'you@inbox.kody.codes. You send an email and your package saves it, routes it to an agent, or triggers anything else.',
	},
	{
		trigger: 'Event',
		title: 'Purchase thanks',
		icon: 'gift',
		copy: 'A purchase lands. Your package wakes an agent to look up past conversations with them and draft a contextual thank-you note.',
	},
] as const

type FactoryBeatIcon = (typeof factoryBeats)[number]['icon']

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
	const [onboarding, authConfig] = await Promise.all([
		fetchOnboardingPayload(signal),
		fetchPublicAuthConfig(signal),
	])
	const result: RouteLoaderResult = {}
	if (onboarding) result.onboarding = onboarding
	result.signupMode = parseSignupMode(authConfig?.signupMode)
	result.walkthroughHosts = pickWalkthroughHosts()
	return result
}

type HomePagePayloads = {
	onboarding: OnboardingPayload | null
	walkthroughHosts?: WalkthroughHostPick
	signupMode?: SignupMode
}

export function HomeRoute(handle: Handle) {
	let loggedIn = false
	let discoveryPrompt = ''
	let walkthroughHosts: WalkthroughHostPick | null = null
	let signupMode: SignupMode = 'invite'
	/** Payload last applied to the closure state above. */
	let appliedPayload: HomePagePayloads | null = null
	const homeData = createRouteData<'onboarding', HomePagePayloads>({
		consume(handle, href) {
			if (!isHomePath(href)) return null
			const onboarding = tryConsumeRouteLoaderData(handle, 'onboarding', href)
			const hosts = tryConsumeRouteLoaderData(handle, 'walkthroughHosts', href)
			const signupModeData = tryConsumeRouteLoaderData(
				handle,
				'signupMode',
				href,
			)
			// Optional keys stand on their own; apply them even when the
			// required onboarding key is missing and the fallback fetch runs.
			if (hosts) walkthroughHosts = hosts
			if (signupModeData) signupMode = signupModeData
			if (!onboarding) return null
			return {
				onboarding,
				walkthroughHosts: hosts,
				signupMode: signupModeData,
			}
		},
		async load(_href, signal) {
			const [onboarding, authConfig] = await Promise.all([
				fetchOnboardingPayload(signal),
				fetchPublicAuthConfig(signal),
			])
			return {
				onboarding,
				walkthroughHosts: walkthroughHosts ?? pickWalkthroughHosts(),
				signupMode: parseSignupMode(authConfig?.signupMode),
			}
		},
	})

	function applyOnboardingPayload(payload: OnboardingPayload | null) {
		loggedIn = payload?.loggedIn === true
		discoveryPrompt = payload?.discoveryPrompt ?? ''
	}

	function applyHomePayload(payload: HomePagePayloads) {
		if (payload.walkthroughHosts) walkthroughHosts = payload.walkthroughHosts
		if (payload.signupMode) signupMode = payload.signupMode
		applyOnboardingPayload(payload.onboarding)
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = homeData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			applyHomePayload(snapshot.data)
		}
		const pending = snapshot.kind === 'pending'
		const busy = pending && appliedPayload !== null

		// A failed fallback fetch still settles the door for a visitor.
		const onboardingReady = appliedPayload !== null || snapshot.kind === 'error'
		const isSignedIn = onboardingReady && loggedIn

		return (
			<div aria-busy={busy ? 'true' : undefined}>
				{busy ? renderRoutePendingStatus() : null}
				<section data-parallax-scope class="landing-hero">
					<h1 data-rise style={{ '--rise': '0' }} class="landing-hero-title">
						{landingHeroHeadlineLead} <em>{landingHeroHeadlineAccent}</em>
						<br />
						{landingHeroHeadlineRest}
					</h1>
					<LandingHeroAgents hosts={walkthroughHosts ?? undefined} />
					{isSignedIn ? null : (
						<div
							data-rise
							style={{ '--rise': '2' }}
							class="landing-hero-actions"
						>
							{signupMode === 'open' ? (
								<a
									href={homepageSignupPath}
									class="landing-pill landing-hero-cta"
								>
									{publicCreateAccountLabel}
								</a>
							) : (
								<a href="#invite" class="landing-pill landing-hero-cta">
									{publicJoinWaitlistLabel}
								</a>
							)}
							{discoveryPrompt ? (
								<span class="landing-hero-cta landing-hero-copy">
									<CopyTextButton
										class="landing-hero-copy-button"
										value={discoveryPrompt}
										idleLabel={landingHeroCopyPromptLabel}
										variant="ghost"
									/>
								</span>
							) : null}
						</div>
					)}
				</section>

				<section aria-labelledby="pitch-title" class="landing-pitch">
					<h2 id="pitch-title" class="landing-pitch-title">
						<em>Nothing</em> new <br />
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
						From ad hoc prompts to <em>durable software</em>
					</h2>
					<p class="landing-factory-lead">
						Stop burning your tokens on the same thing over and over again. Turn
						any process into <strong>durable software</strong> you can trigger
						on a schedule, notification, or anything else{' '}
						<strong>without expensive inference</strong>.
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
								<h3 class="landing-factory-beat-title">
									{renderFactoryBeatIcon(beat.icon)}
									{beat.title}
								</h3>
								<p>{beat.copy}</p>
							</article>
						))}
					</div>
					<p class="landing-factory-ritual">
						<span>Ask once.</span> <span>Save it.</span>{' '}
						<span>Trigger it.</span>
					</p>
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
							Your own <em>git</em> and <em>npm</em>.
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
					<div class="landing-byok-copy">
						<h2 id="byok-title" class="landing-section-heading">
							A <em>secure</em> vault for your <em>secrets</em>.
						</h2>
						<LandingByokDemo hosts={walkthroughHosts ?? undefined} />
						<p class="landing-split-copy">
							<strong>Encrypted keys the agent never sees.</strong> You create
							the connection yourself, with your agent walking you through it:
							your app, your scopes, revocable anytime. Secrets never enter the
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
						It already speaks <em>your tools</em>
					</h2>
					<p class="landing-world-lead">
						Works with the agents and services you already use. Browse public
						packages, fork them with your agent, and make them yours.
					</p>
					<ul
						aria-label="Agents and developer services that work with Kody"
						class="landing-world-cloud"
					>
						{landingWorldBrands.map((brand, index) => (
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
							mix={revealPop(landingWorldBrands.length * 35)}
						>
							…and yours
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
						Give your agents a <em>home</em>
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
									{publicCreateAccountLabel}
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
									{publicHaveCodeLabel}
								</a>
							</p>
						</>
					)}
				</section>
			</div>
		)
	}
}

function factoryBeatIconSvg(paths: RemixNode) {
	return (
		<svg
			viewBox="0 0 24 24"
			width="22"
			height="22"
			aria-hidden="true"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			{paths}
		</svg>
	)
}

function renderFactoryBeatIcon(icon: FactoryBeatIcon) {
	switch (icon) {
		case 'target':
			return factoryBeatIconSvg(
				<>
					<circle cx="12" cy="12" r="8" />
					<circle cx="12" cy="12" r="3.25" />
					<path d="M12 2.5v2.75M12 18.75V21.5M2.5 12h2.75M18.75 12H21.5" />
				</>,
			)
		case 'alert':
			return factoryBeatIconSvg(
				<>
					<path d="M12 4 21 19.5H3L12 4Z" />
					<path d="M12 10v4.25" />
					<circle cx="12" cy="16.75" r="0.75" fill="currentColor" />
				</>,
			)
		case 'envelope':
			return factoryBeatIconSvg(
				<>
					<rect x="3.5" y="6" width="17" height="12" rx="2" />
					<path d="m4.2 7.6 7.8 5.2 7.8-5.2" />
				</>,
			)
		case 'gift':
			return factoryBeatIconSvg(
				<>
					<rect x="3.5" y="8" width="17" height="4" rx="1" />
					<rect x="5" y="12" width="14" height="8.5" rx="1" />
					<path d="M12 8v12.5" />
					<path d="M12 8c-2.4-3.4-6-2.4-6 0 0 1.4 1.9 2.4 6 2.8 4.1-.4 6-1.4 6-2.8 0-2.4-3.6-3.4-6 0" />
				</>,
			)
		default: {
			const exhaustive: never = icon
			return exhaustive
		}
	}
}
