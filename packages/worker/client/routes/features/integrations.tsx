import { type Handle } from 'remix/component'
import { FeatureRelated } from './feature-related.tsx'
import {
	integrationAccountStatus,
	IntegrationsHeroScene,
	IntegrationsReuseScene,
	type IntegrationAccountId,
	type IntegrationEventId,
	type IntegrationPackageId,
} from './integrations-scenes.tsx'
import { IntegrationsSetup } from './integrations-setup.tsx'

export function IntegrationsFeature(handle: Handle) {
	let account: IntegrationAccountId = 'work'
	let event: IntegrationEventId | null = null
	let heroShot = 0
	let selectedPackage: IntegrationPackageId = 'brief'
	let packageShot = 0
	return () => (
		<div class="study integrations">
			<div class="split">
				<div>
					<img
						class="feature-orb"
						src="/images/lantern/kody-primitives-orb-integrations.webp"
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Connect an account.
						<br />
						<em>Put it to work.</em>
					</h1>
					<p class="lead">
						Keep your service connections in Kody. Use packages to turn that
						access into useful tools and workflows.
					</p>
					<a class="action" href="/docs/oauth">
						See how setup works
					</a>
				</div>
				<div>
					<span class="example">Example connection, fictional data</span>
					<IntegrationsHeroScene
						account={account}
						event={event}
						shot={heroShot}
						onAccount={(next) => {
							account = next
							event = null
							heroShot += 1
							handle.update()
						}}
						onEvent={(next) => {
							event = next
							heroShot += 1
							handle.update()
						}}
					/>
					<p class="visually-hidden" aria-live="polite">
						{integrationAccountStatus(account, event)}
					</p>
				</div>
			</div>
			<section class="story-section ia-reuse">
				<div class="story-split">
					<div>
						<h2>
							Sign in once.
							<br />
							Put the connection to work.
						</h2>
						<p>
							Your connection supplies the account and its permissions. A
							package supplies the action. Reuse the same saved connection in
							the tools you build.
						</p>
						<p class="ia-note">
							Connecting a service does not install its tools.
						</p>
						<a href="/features/packages">Explore packages ↗</a>
					</div>
					<div>
						<span class="example">Example connection, fictional data</span>
						<IntegrationsReuseScene
							selected={selectedPackage}
							shot={packageShot}
							onSelect={(next) => {
								selectedPackage = next
								packageShot += 1
								handle.update()
							}}
						/>
					</div>
				</div>
			</section>
			<IntegrationsSetup />
			<FeatureRelated
				links={[
					{ href: '/integrations/gmail', label: 'Gmail integration' },
					{ href: '/integrations/slack', label: 'Slack integration' },
					{ href: '/integrations/claude', label: 'Claude integration' },
					{ href: '/features/packages', label: 'Reusable packages' },
				]}
			/>
			<div class="feature-start">
				<a href="/docs/oauth">Read the OAuth setup guide</a>
				<a class="action" href="/onboarding">
					Connect your agent
				</a>
			</div>
		</div>
	)
}
