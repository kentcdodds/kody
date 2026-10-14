import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'
import { type Handle } from 'remix/component'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	createRouteData,
	renderRoutePendingStatus,
} from '#client/route-data.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { reveal, revealPop } from '#client/reveal.ts'
import { landingArtAttrs } from '#universal/landing-images.ts'
import { docHref } from '#universal/docs-nav.ts'
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
	landingIsHeadingIs,
	landingIsHeadingIsNot,
	landingIsHeadingJoin,
	landingIsHeadingLead,
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
import { pickWithAgentOrder } from '#universal/with-agents.ts'
import { LandingAgentMarquee } from '#client/routes/landing-agent-marquee.tsx'
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
 * The orbit walkthrough, team ecosystem, and videos prove it, and the page
 * closes on invisible software. The connect CTA copies an agent-led setup prompt, so the page
 * never links to `/onboarding`. Motion is enhance-only (`html.js`) and fully
 * off under `prefers-reduced-motion`.
 *
 * Layout styles live in `public/styles.css` (`.landing-*`) so SSR does not
 * emit a per-node `<style data-rmx>` tag for every marketing block.
 */

const ecosystemPathSteps = [
	{
		kicker: 'Repos',
		title: 'Team git',
		note: 'Shared repos your agents write.',
	},
	{
		kicker: 'Registry',
		title: 'Team npm',
		note: 'Packages anyone can run.',
	},
	{
		kicker: 'Share',
		title: 'Community',
		note: 'Fork public, publish yours.',
	},
] as const

const ecosystemTriggers = ['Webhook', 'Cron', 'HTTP', 'App'] as const

const believeHref = routes.believe.href()
const connectYourAgentDocHref = docHref('connect-your-agent')

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
	return {
		walkthroughHosts: pickWalkthroughHosts(),
		landingAgentOrder: pickWithAgentOrder(),
		landingHeroVideos: await fetchLandingHeroVideos(signal),
	}
}

type HomePagePayloads = {
	walkthroughHosts?: WalkthroughHostPick
	landingHeroVideos: Array<LandingHeroVideoItem>
}

export function HomeRoute(handle: Handle) {
	let walkthroughHosts: WalkthroughHostPick | null = null
	let landingAgentOrder: Array<string> | null = null
	let landingHeroVideos: Array<LandingHeroVideoItem> = []
	/** Payload last applied to the closure state above. */
	let appliedPayload: HomePagePayloads | null = null
	const homeData = createRouteData<'landingHeroVideos', HomePagePayloads>({
		consume(handle, href) {
			if (!isHomePath(href)) return null
			const hosts = tryConsumeRouteLoaderData(handle, 'walkthroughHosts', href)
			const agentOrder = tryConsumeRouteLoaderData(
				handle,
				'landingAgentOrder',
				href,
			)
			if (agentOrder) landingAgentOrder = agentOrder
			const videos = tryConsumeRouteLoaderData(
				handle,
				'landingHeroVideos',
				href,
			)
			// Hosts stand on their own; apply them even when the videos key is
			// missing and the fallback fetch runs.
			if (hosts) walkthroughHosts = hosts
			if (!videos) return null
			return { walkthroughHosts: hosts, landingHeroVideos: videos }
		},
		async load(_href, signal) {
			return {
				walkthroughHosts: walkthroughHosts ?? pickWalkthroughHosts(),
				landingHeroVideos: await fetchLandingHeroVideos(signal),
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
							style={{ '--rise': '0.8' }}
							class="landing-agents-row"
						>
							<LandingAgentMarquee order={landingAgentOrder} />
						</div>
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
						{landingIsHeadingLead}
						<em>{landingIsHeadingIs}</em>
						{landingIsHeadingJoin}
						<em>{landingIsHeadingIsNot}</em>
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
							Your team&rsquo;s own <em>git</em> and <em>npm</em>.
						</h2>
						<p class="landing-split-copy">
							One workspace your whole team shares: repos any teammate&rsquo;s
							agent can build in, packages the team publishes once, and triggers
							that run them for everyone.
						</p>
						<div class="landing-path landing-path-split">
							{renderLandingPathSteps(
								ecosystemPathSteps,
								'From your team\u2019s git to the community',
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

/**
 * The page's one call to action: copy an agent-led setup prompt. Copying
 * needs JavaScript, so without it the same label links to the connect docs.
 */
function renderConnectCta() {
	return (
		<>
			<span class="landing-connect-copy">
				<BuildWithAgentButton
					label={landingHeroPrimaryCta}
					variant="pill"
					onboardingPage={false}
					icons={false}
				/>
			</span>
			<a
				href={connectYourAgentDocHref}
				class="landing-connect-fallback landing-inline-link"
			>
				{landingHeroPrimaryCta}
			</a>
		</>
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
