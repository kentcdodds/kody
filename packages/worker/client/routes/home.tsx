import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'
import { type Handle } from 'remix/component'
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
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { reveal, revealPop } from '#client/reveal.ts'
import { landingArtAttrs } from '#universal/landing-images.ts'
import { landingFactoryBeats } from '#universal/landing-factory-beats.ts'
import { renderIcon } from '#universal/icon.tsx'
import { routes } from '#universal/routes.ts'
import {
	isLandingHeroVideo,
	landingHeroChooserLabelEmphasis,
	landingHeroChooserLabelLead,
	presentLandingHeroVideos,
	type LandingHeroVideo as LandingHeroVideoItem,
} from '#universal/landing-hero-copy.ts'
import {
	landingClosingBelieveLink,
	landingClosingHeadingEmphasis,
	landingClosingHeadingLead,
	landingClosingLead,
	landingCompareCaption,
	landingCompareWithItems,
	landingCompareWithoutItems,
	landingCompareWithTitle,
	landingCompareWithoutTitle,
	landingHeroHeadlineEmphasis,
	landingHeroHeadlineLead,
	landingHeroHeadlineTail,
	landingHeroPlugLine,
	landingHeroPrimaryCta,
	landingHeroSubhead,
	landingIsHeading,
	landingIsItem,
	landingIsNotItems,
} from '#universal/landing-home-copy.ts'
import {
	accountDeletedConfirmationMessage,
	isAccountDeletedHome,
} from '#universal/account-deletion-confirmation.ts'
import {
	pickWalkthroughHosts,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import { LandingHeroAgents } from '#client/routes/landing-hero-agents.tsx'
import { LandingHeroVideo } from '#client/routes/landing-hero-video.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { LandingPrimitiveCards } from '#client/routes/landing-primitive-cards.tsx'
import { LandingTestimonialsCarousel } from './landing-testimonials-carousel.tsx'
import { LandingLoopPlayer } from './landing-loop-player.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'

/**
 * Public landing page. The shared team cloud is the door: H1, one connect
 * CTA, compare, primitive cards, and what Kody is and is not come first.
 * Factory / orbit / videos prove it, and the page closes on invisible
 * software. The connect CTA copies an agent-led setup prompt, so the page
 * never links to `/onboarding`. Motion is enhance-only (`html.js`) and fully
 * off under `prefers-reduced-motion`.
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

const believeHref = routes.believe.href()

function isHomePath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/'
}

const landingHeroVideosApiPath = routes.landingHeroVideosApi.href()

async function fetchLandingHeroVideos(signal: AbortSignal) {
	try {
		const response = await fetch(landingHeroVideosApiPath, {
			headers: { Accept: 'application/json' },
			signal,
		})
		const payload = await readJson<{
			ok?: boolean
			videos?: Array<LandingHeroVideoItem>
		}>(response)
		if (!response.ok || !payload?.ok || !Array.isArray(payload.videos)) {
			return []
		}
		return presentLandingHeroVideos(payload.videos.filter(isLandingHeroVideo))
	} catch (error) {
		if (signal.aborted) throw error
		return []
	}
}

export async function homeRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const [onboarding, landingHeroVideos] = await Promise.all([
		fetchOnboardingPayload(signal),
		fetchLandingHeroVideos(signal),
	])
	const result: RouteLoaderResult = {}
	if (onboarding) result.onboarding = onboarding
	result.walkthroughHosts = pickWalkthroughHosts()
	result.landingHeroVideos = landingHeroVideos
	return result
}

type HomePagePayloads = {
	onboarding: OnboardingPayload | null
	walkthroughHosts?: WalkthroughHostPick
	landingHeroVideos: Array<LandingHeroVideoItem>
}

export function HomeRoute(handle: Handle) {
	let walkthroughHosts: WalkthroughHostPick | null = null
	let landingHeroVideos: Array<LandingHeroVideoItem> = []
	/** Payload last applied to the closure state above. */
	let appliedPayload: HomePagePayloads | null = null
	const homeData = createRouteData<'onboarding', HomePagePayloads>({
		consume(handle, href) {
			if (!isHomePath(href)) return null
			const onboarding = tryConsumeRouteLoaderData(handle, 'onboarding', href)
			const hosts = tryConsumeRouteLoaderData(handle, 'walkthroughHosts', href)
			const videos = tryConsumeRouteLoaderData(
				handle,
				'landingHeroVideos',
				href,
			)
			// Optional keys stand on their own; apply them even when the
			// required onboarding key is missing and the fallback fetch runs.
			if (hosts) walkthroughHosts = hosts
			if (videos) landingHeroVideos = presentLandingHeroVideos(videos)
			if (!onboarding) return null
			return {
				onboarding,
				walkthroughHosts: hosts,
				landingHeroVideos: videos
					? presentLandingHeroVideos(videos)
					: landingHeroVideos,
			}
		},
		async load(_href, signal) {
			const [onboarding, videos] = await Promise.all([
				fetchOnboardingPayload(signal),
				fetchLandingHeroVideos(signal),
			])
			return {
				onboarding,
				walkthroughHosts: walkthroughHosts ?? pickWalkthroughHosts(),
				landingHeroVideos: videos,
			}
		},
	})

	function applyHomePayload(payload: HomePagePayloads) {
		if (payload.walkthroughHosts) walkthroughHosts = payload.walkthroughHosts
		landingHeroVideos = presentLandingHeroVideos(payload.landingHeroVideos)
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

		const showAccountDeleted = isAccountDeletedHome(
			new URL(currentHref, 'https://kody.local').search,
		)

		return (
			<div aria-busy={busy ? 'true' : undefined}>
				{busy ? renderRoutePendingStatus() : null}
				{showAccountDeleted ? (
					<p
						role="status"
						data-testid="account-deleted-notice"
						class="landing-account-deleted"
					>
						{accountDeletedConfirmationMessage}
					</p>
				) : null}
				<section class="landing-hero">
					<div class="landing-hero-intro">
						<h1 data-rise style={{ '--rise': '0' }} class="landing-hero-title">
							{landingHeroHeadlineLead}
							<em>{landingHeroHeadlineEmphasis}</em>
							{landingHeroHeadlineTail}
						</h1>
						<h2
							data-rise
							style={{ '--rise': '0.6' }}
							class="landing-hero-subhead"
						>
							{landingHeroSubhead}
						</h2>
						<div
							data-rise
							style={{ '--rise': '1' }}
							class="landing-hero-actions"
						>
							{renderConnectCta()}
						</div>
					</div>
					<p data-rise style={{ '--rise': '1.4' }} class="landing-hero-plug">
						{landingHeroPlugLine}
					</p>
					<div class="landing-compare">
						<div class="landing-compare-col">
							<h3 id="compare-without-title" class="landing-compare-title">
								{landingCompareWithoutTitle}
							</h3>
							<ul
								aria-labelledby="compare-without-title"
								class="landing-compare-list"
							>
								{landingCompareWithoutItems.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</div>
						<div class="landing-compare-col landing-compare-col-with">
							<h3 id="compare-with-title" class="landing-compare-title">
								{landingCompareWithTitle}
							</h3>
							<ul
								aria-labelledby="compare-with-title"
								class="landing-compare-list"
							>
								{landingCompareWithItems.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</div>
					</div>
					<p class="landing-compare-caption">{landingCompareCaption}</p>
				</section>

				<LandingPrimitiveCards />

				<section aria-labelledby="is-title" class="landing-vs">
					<h2 id="is-title" class="landing-section-heading">
						{landingIsHeading}
					</h2>
					<ul class="landing-vs-list">
						{landingIsNotItems.map((item) => (
							<li key={item.kicker} class="landing-vs-item" mix={reveal()}>
								<p class="landing-vs-kicker">{item.kicker}</p>
								<p class="landing-vs-body">{item.body}</p>
							</li>
						))}
						<li class="landing-vs-item landing-vs-item-is" mix={reveal()}>
							<p class="landing-vs-kicker">{landingIsItem.kicker}</p>
							<p class="landing-vs-body">{landingIsItem.body}</p>
						</li>
					</ul>
				</section>

				<section
					id="durable-software"
					aria-labelledby="factory-title"
					class="landing-factory"
				>
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
							{landingFactoryBeats.map((beat, index) => (
								<li
									key={beat.title}
									class="landing-path-fan-slot"
									mix={reveal(index * 70)}
								>
									<a
										href={routes.docDetail.href({ slug: beat.slug })}
										class="landing-path-fan-item landing-path-fan-link"
									>
										<span class="landing-path-kicker">{beat.trigger}</span>
										<span class="landing-path-fan-title">
											{renderIcon(beat.icon, { size: '22' })}
											{beat.title}
										</span>
									</a>
								</li>
							))}
						</ul>
					</div>
					<p class="landing-factory-ritual">
						<span>Ask once.</span> <span>Save it.</span>{' '}
						<span>Trigger it.</span>
					</p>
				</section>

				<section class="landing-proof">
					<div class="landing-proof-split">
						<LandingHeroAgents hosts={walkthroughHosts ?? undefined} />
						<div class="landing-walkthrough-story notranslate" translate="no">
							<div class="landing-walkthrough-intro">
								{walkthroughHosts ? (
									<WalkthroughHostIntro
										variant="picker"
										hosts={walkthroughHosts}
										onHostsChange={(next) => {
											walkthroughHosts = next
											handle.update()
										}}
									/>
								) : null}
							</div>
							<LandingLoopPlayer hosts={walkthroughHosts ?? undefined} />
						</div>
					</div>
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
							An ecosystem for individuals and teams: isolated repos, packages
							you publish, then trigger what you save.
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

				{landingHeroVideos.length > 0 ? (
					<section aria-labelledby="videos-title" class="landing-videos">
						<h2 id="videos-title" class="landing-section-heading">
							{landingHeroChooserLabelLead}
							<em>{landingHeroChooserLabelEmphasis}</em>
						</h2>
						<LandingHeroVideo videos={landingHeroVideos} />
					</section>
				) : null}

				<section
					id="invisible-software"
					aria-labelledby="closing-title"
					class="landing-invite"
				>
					<img
						{...landingArtAttrs('kody-greeting')}
						alt="Kody waving hello with an open hand"
						class="landing-invite-art"
					/>
					<h2
						id="closing-title"
						class="landing-section-heading landing-invite-title"
					>
						{landingClosingHeadingLead}
						<em>{landingClosingHeadingEmphasis}</em>
					</h2>
					<p class="landing-invite-lead">{landingClosingLead}</p>
					<p class="landing-invite-believe">
						<a href={believeHref} class="landing-inline-link">
							{landingClosingBelieveLink} <span aria-hidden="true">→</span>
						</a>
					</p>
					<div class="landing-invite-cta">{renderConnectCta()}</div>
				</section>
			</div>
		)
	}
}

/** The page's one call to action: copy an agent-led setup prompt. */
function renderConnectCta() {
	return (
		<BuildWithAgentButton
			label={landingHeroPrimaryCta}
			variant="pill"
			onboardingPage={false}
		/>
	)
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
