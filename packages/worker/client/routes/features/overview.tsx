import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'
import {
	MemoryOverviewDemo,
	SecretsOverviewDemo,
	PackagesOverviewDemo,
} from './overview-knowledge-demos.tsx'
import {
	TriggersOverviewDemo,
	IntegrationsOverviewDemo,
	AppsOverviewDemo,
} from './overview-work-demos.tsx'
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
				<article class="feature" style={{ '--hue': '29' }}>
					<MemoryOverviewDemo />
					<div class="pitch">
						<div class="feature-name">
							<img
								src="/images/lantern/kody-primitives-orb-memory.webp"
								width="38"
								height="38"
								alt=""
							/>
							<h2>Memory</h2>
						</div>
						<h3>Context that comes with you.</h3>
						<p>
							Save the facts and preferences you keep repeating. Your connected
							agents can find the relevant details when they need them.
						</p>
						<a href="/features/memory">
							Explore memory <span aria-hidden="true">↗</span>
						</a>
					</div>
				</article>
				<article class="feature" style={{ '--hue': '300' }}>
					<SecretsOverviewDemo />
					<div class="pitch">
						<div class="feature-name">
							<img
								src="/images/lantern/kody-primitives-orb-secrets.webp"
								width="38"
								height="38"
								alt=""
							/>
							<h2>Secrets</h2>
						</div>
						<h3>Access without handing over the key.</h3>
						<p>
							Let your agent use credentials through Kody. Approve where they
							can be sent and which packages can use them.
						</p>
						<a href="/features/secrets">
							Explore secrets <span aria-hidden="true">↗</span>
						</a>
					</div>
				</article>
				<article class="feature" style={{ '--hue': '255' }}>
					<PackagesOverviewDemo />
					<div class="pitch">
						<div class="feature-name">
							<img
								src="/images/lantern/kody-primitives-orb-packages.webp"
								width="38"
								height="38"
								alt=""
							/>
							<h2>Packages</h2>
						</div>
						<h3>Keep the software your agent builds.</h3>
						<p>
							Turn a useful one-off into reusable code. Inspect the source,
							publish changes, and share a live package or make your own copy.
						</p>
						<a href="/features/packages">
							Explore packages <span aria-hidden="true">↗</span>
						</a>
					</div>
				</article>
				<article class="feature" style={{ '--hue': '96' }}>
					<TriggersOverviewDemo />
					<div class="pitch">
						<div class="feature-name">
							<img
								src="/images/lantern/kody-primitives-orb-triggers.webp"
								width="38"
								height="38"
								alt=""
							/>
							<h2>Triggers</h2>
						</div>
						<h3>Keep working after the chat closes.</h3>
						<p>
							Run your packages when a webhook arrives, mail comes in, or a
							scheduled check is due. Call an agent when the work needs one.
						</p>
						<a href="/features/triggers">
							Explore triggers <span aria-hidden="true">↗</span>
						</a>
					</div>
				</article>
				<article class="feature" style={{ '--hue': '148' }}>
					<IntegrationsOverviewDemo />
					<div class="pitch">
						<div class="feature-name">
							<img
								src="/images/lantern/kody-primitives-orb-integrations.webp"
								width="38"
								height="38"
								alt=""
							/>
							<h2>Integrations</h2>
						</div>
						<h3>Connect your accounts once.</h3>
						<p>
							Keep named service connections in Kody and reuse them across
							packages. The connection supplies access, the package does the
							work.
						</p>
						<a href="/features/integrations">
							Explore integrations <span aria-hidden="true">↗</span>
						</a>
					</div>
				</article>
				<article class="feature" style={{ '--hue': '345' }}>
					<AppsOverviewDemo />
					<div class="pitch">
						<div class="feature-name">
							<img
								src="/images/lantern/kody-primitives-orb-apps.webp"
								width="38"
								height="38"
								alt=""
							/>
							<h2>Apps</h2>
						</div>
						<h3>Give your work a place to happen.</h3>
						<p>
							Ask your agent for a tool you can open and use. Kody hosts the
							interface, keeps the package’s data, and lets you share access.
						</p>
						<a href="/features/apps">
							Explore apps <span aria-hidden="true">↗</span>
						</a>
					</div>
				</article>
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
				<a class="cta" href="/onboarding">
					Connect your agent
				</a>
				<BuildWithAgentButton />
			</section>
		</div>
	)
}
