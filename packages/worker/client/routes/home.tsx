import { type Handle } from 'remix/ui'
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
import { landingArtAttrs } from '#universal/landing-images.ts'
import { landingWorldBrands } from '#universal/landing-world-brands.ts'
import { renderIcon, type IconName } from '#universal/icon.tsx'
import { homepageSignupPath } from '#universal/first-touch-attribution.ts'
import { routes } from '#universal/routes.ts'
import {
	landingHeroCopyPromptLabel,
	landingHeroHeadlineAccent,
	landingHeroHeadlineLead,
	landingHeroHeadlineRest,
} from '#universal/landing-hero-copy.ts'
import { publicCreateAccountLabel } from '#universal/public-signup-copy.ts'
import {
	pickWalkthroughHosts,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import { LandingHeroAgents } from '#client/routes/landing-hero-agents.tsx'
import { LandingHeroVideo } from '#client/routes/landing-hero-video.tsx'
import { LandingByokDemo } from './landing-byok-demo.tsx'
import { LandingTestimonialsCarousel } from './landing-testimonials-carousel.tsx'
import { LandingLoopPlayer } from './landing-loop-player.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'

/**
 * Public landing page, ported from the redesign prototype
 * (`landing/landing.html`). Flat neutral canvas, one vibrant green accent,
 * centered single-column flow, mascot illustrations doing the explanatory
 * work. Motion is enhance-only (`html.js`) and fully off under
 * `prefers-reduced-motion`.
 *
 * Positioning (public door): stop sweating switching agents. The top fold is
 * H1 + CTAs beside the demo (lite YouTube player); Kody with the host agents
 * tethered around the lantern sits under that row. The H1 matches the home
 * OG card. Factory / npm / packages stay below the fold.
 * The factory closer is the ritual: ask once, save it, trigger it.
 *
 * Layout styles live in `public/styles.css` (`.landing-*`) so SSR does not
 * emit a per-node `<style data-rmx>` tag for every marketing block.
 */

const factoryPathSteps = [
	{
		kicker: 'Today',
		title: 'Ad hoc prompt',
		note: 'Same question. More tokens.',
	},
	{
		kicker: 'Save it',
		title: 'A package',
		note: 'Durable software you own.',
	},
	{
		kicker: 'Trigger it',
		title: 'No inference',
		note: 'Cron, webhook, email, or event.',
	},
] as const

const factoryBeats = [
	{ trigger: 'Cron', title: 'Flake Hunter', icon: 'target' },
	{ trigger: 'Webhook', title: 'Sentry Issues', icon: 'warning-triangle' },
	{ trigger: 'Email', title: 'Agent inbox', icon: 'mail' },
	{ trigger: 'Event', title: 'Purchase thanks', icon: 'heart' },
] as const satisfies ReadonlyArray<{
	trigger: string
	title: string
	icon: IconName
}>

const ecosystemPathSteps = [
	{
		kicker: 'Repos',
		title: 'Your git',
		note: 'Isolated, agent-written.',
	},
	{
		kicker: 'Registry',
		title: 'Your npm',
		note: 'Packages you can run.',
	},
	{
		kicker: 'Share',
		title: 'Community',
		note: 'Fork public, publish yours.',
	},
] as const

const ecosystemTriggers = ['Webhook', 'Cron', 'HTTP', 'App'] as const

const kodyGithubUrl = 'https://github.com/kentcdodds/kody'
const secretsDocsHref = routes.docDetail.href({ slug: 'secrets' })
const communityHref = routes.community.href()

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
	const onboarding = await fetchOnboardingPayload(signal)
	const result: RouteLoaderResult = {}
	if (onboarding) result.onboarding = onboarding
	result.walkthroughHosts = pickWalkthroughHosts()
	return result
}

type HomePagePayloads = {
	onboarding: OnboardingPayload | null
	walkthroughHosts?: WalkthroughHostPick
}

export function HomeRoute(handle: Handle) {
	let loggedIn = false
	let discoveryPrompt = ''
	let walkthroughHosts: WalkthroughHostPick | null = null
	/** Payload last applied to the closure state above. */
	let appliedPayload: HomePagePayloads | null = null
	const homeData = createRouteData<'onboarding', HomePagePayloads>({
		consume(handle, href) {
			if (!isHomePath(href)) return null
			const onboarding = tryConsumeRouteLoaderData(handle, 'onboarding', href)
			const hosts = tryConsumeRouteLoaderData(handle, 'walkthroughHosts', href)
			// Optional keys stand on their own; apply them even when the
			// required onboarding key is missing and the fallback fetch runs.
			if (hosts) walkthroughHosts = hosts
			if (!onboarding) return null
			return {
				onboarding,
				walkthroughHosts: hosts,
			}
		},
		async load(_href, signal) {
			const onboarding = await fetchOnboardingPayload(signal)
			return {
				onboarding,
				walkthroughHosts: walkthroughHosts ?? pickWalkthroughHosts(),
			}
		},
	})

	function applyOnboardingPayload(payload: OnboardingPayload | null) {
		loggedIn = payload?.loggedIn === true
		discoveryPrompt = payload?.discoveryPrompt ?? ''
	}

	function applyHomePayload(payload: HomePagePayloads) {
		if (payload.walkthroughHosts) walkthroughHosts = payload.walkthroughHosts
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
					<div class="landing-hero-top">
						<div class="landing-hero-intro">
							<h1
								data-rise
								style={{ '--rise': '0' }}
								class="landing-hero-title"
							>
								<span class="landing-hero-title-line">
									{landingHeroHeadlineLead} <em>{landingHeroHeadlineAccent}</em>
								</span>
								<span class="landing-hero-title-line">
									{landingHeroHeadlineRest}
								</span>
							</h1>
							{isSignedIn ? null : (
								<div
									data-rise
									style={{ '--rise': '2' }}
									class="landing-hero-actions"
								>
									<a
										href={homepageSignupPath}
										class="landing-pill landing-hero-cta"
									>
										{publicCreateAccountLabel}
									</a>
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
						</div>
						<LandingHeroVideo />
					</div>
					<LandingHeroAgents hosts={walkthroughHosts ?? undefined} />
				</section>

				<section aria-labelledby="factory-title" class="landing-factory">
					<h2 id="factory-title" class="landing-section-heading">
						From ad hoc prompts to <em>durable software</em>
					</h2>
					<p class="landing-factory-lead">
						Stop re-paying for the same answer. Save the process, then trigger
						it <strong>without expensive inference</strong>.
					</p>
					<div class="landing-path">
						{renderLandingPathSteps(
							factoryPathSteps,
							'From ad hoc prompt to trigger',
						)}
						<div class="landing-path-stem" aria-hidden="true"></div>
						<ul class="landing-path-fan" aria-label="Example triggers">
							{factoryBeats.map((beat, index) => (
								<li
									key={beat.title}
									class="landing-path-fan-item"
									mix={reveal(index * 70)}
								>
									<p class="landing-path-kicker">{beat.trigger}</p>
									<p class="landing-path-fan-title">
										{renderIcon(beat.icon, { size: '22' })}
										{beat.title}
									</p>
								</li>
							))}
						</ul>
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

				<section aria-labelledby="ecosystem-title" class="landing-ecosystem">
					<div>
						<h2 id="ecosystem-title" class="landing-section-heading">
							Your own <em>git</em> and <em>npm</em>.
						</h2>
						<p class="landing-split-copy">
							A personal software ecosystem: isolated repos, packages you
							publish, then trigger what you save.
						</p>
						<div class="landing-path landing-path-split">
							{renderLandingPathSteps(
								ecosystemPathSteps,
								'From your git to the community',
							)}
							<div class="landing-path-stem" aria-hidden="true"></div>
							<ul
								class="landing-path-fan landing-path-fan-chips"
								aria-label="Ways to trigger a package"
							>
								{ecosystemTriggers.map((trigger, index) => (
									<li
										key={trigger}
										class="landing-chip"
										mix={revealPop(index * 40)}
									>
										{trigger}
									</li>
								))}
							</ul>
						</div>
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
							the connection; secrets stay out of the prompt.{' '}
							<a href={secretsDocsHref} class="landing-inline-link">
								How secrets work
							</a>
							.
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
						aria-label="Agents, developer services, and community packages that work with Kody"
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
						<li class="landing-world-link-item">
							<a
								href={communityHref}
								class="landing-chip landing-chip-muted landing-chip-link"
								mix={revealPop(landingWorldBrands.length * 35)}
							>
								Community packages
							</a>
						</li>
					</ul>
				</section>

				<section aria-labelledby="trust-title" class="landing-trust">
					<h2 id="trust-title" class="landing-section-heading">
						Check out Kody&apos;s Source on GitHub
					</h2>
					<p>
						Kody&apos;s {renderGithubRepoLink('source is open')} — read it, fork
						it, self-host it, and {renderGithubRepoLink('star the repo')}.
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
					) : (
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
					)}
				</section>
			</div>
		)
	}
}

type LandingPathStep = {
	kicker: string
	title: string
	note: string
}

function renderLandingPathSteps(
	steps: ReadonlyArray<LandingPathStep>,
	label: string,
) {
	return (
		<ol class="landing-path-rail" aria-label={label}>
			{steps.map((step, index) => (
				<li key={step.title} class="landing-path-step" mix={reveal(index * 80)}>
					<span class="landing-path-node" aria-hidden="true">
						{index + 1}
					</span>
					<p class="landing-path-kicker">{step.kicker}</p>
					<h3 class="landing-path-label">{step.title}</h3>
					<p class="landing-path-note">{step.note}</p>
				</li>
			))}
		</ol>
	)
}

function renderGithubRepoLink(label: string) {
	return (
		<a
			href={kodyGithubUrl}
			target="_blank"
			rel="noreferrer noopener"
			class="landing-inline-link"
		>
			{label}
		</a>
	)
}
