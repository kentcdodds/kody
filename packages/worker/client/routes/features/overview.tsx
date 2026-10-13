import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'
import {
	primitiveCards,
	primitiveFeatureHref,
} from '#universal/primitive-cards.ts'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import { OverviewWidget } from './overview-widgets.tsx'

/** Card accent hues; `feature-pages.css` derives `--accent` from `--hue`. */
const cardHues = {
	memory: '29',
	secrets: '300',
	packages: '255',
	triggers: '96',
	integrations: '148',
	apps: '345',
} as const satisfies Record<LandingPrimitiveId, string>

export function FeaturesOverview() {
	return () => (
		<div class="overview-content">
			<div class="intro">
				<h1>
					Your agents’ work,
					<br />
					<em>all in one place.</em>
				</h1>
				<p>
					Give your agents a place to remember what matters, connect to your
					tools, and build software you can keep using.
				</p>
				<p class="overview-example">Interactive examples use fictional data.</p>
			</div>
			<div class="features">
				{primitiveCards.map((card) => (
					<article
						key={card.id}
						class="feature"
						data-primitive={card.id}
						style={{
							'--hue': cardHues[card.id],
							'--pw-accent': `var(--primitive-${card.id})`,
						}}
					>
						<OverviewWidget id={card.id} />
						<div class="pitch">
							<div class="feature-name">
								<img src={card.orb} width="38" height="38" alt="" />
								<h2>{card.name}</h2>
							</div>
							<h3>{card.title}</h3>
							<p>{card.body}</p>
							<a href={primitiveFeatureHref(card.id)}>
								Explore {card.name.toLowerCase()}{' '}
								<span aria-hidden="true">↗</span>
							</a>
						</div>
					</article>
				))}
			</div>
			<section class="together">
				<h2>
					Useful on their own.
					<br />
					Better in the same place.
				</h2>
				<p>
					A purchase could start a package, use a connected account to prepare a
					draft, and save it in an app for review. Build each part around the
					work you need.
				</p>
				<div class="flow">
					<a href="/features/triggers">Purchase webhook</a>
					<span aria-hidden="true">→</span>
					<a href="/features/packages">Run your package</a>
					<span aria-hidden="true">→</span>
					<a href="/features/integrations">Use your account</a>
					<span aria-hidden="true">→</span>
					<a href="/features/apps">Review in your app</a>
				</div>
				<div class="actions">
					<a class="cta" href="/onboarding">
						Connect your agent
					</a>
					<BuildWithAgentButton />
				</div>
			</section>
		</div>
	)
}
