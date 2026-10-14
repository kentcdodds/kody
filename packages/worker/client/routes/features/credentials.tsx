import { type Handle, on } from 'remix/component'
import { SecretsVault } from './secrets-vault.tsx'
import { FeatureRelated } from './feature-related.tsx'
import {
	SecretsAccessScene,
	SecretsTripScene,
	tripResultCopy,
	type SecretApproval,
	type SecretHost,
} from './secrets-scenes.tsx'
import {
	integrationAccountStatus,
	IntegrationsHeroScene,
	IntegrationsReuseScene,
	type IntegrationAccountId,
	type IntegrationEventId,
	type IntegrationPackageId,
} from './integrations-scenes.tsx'
import { IntegrationsSetup } from './integrations-setup.tsx'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'

const approvals = {
	host: 'An approved destination can receive the credential. An empty host allowlist blocks requests that use secret references.',
	package:
		'Your authored packages and reviewed, adopted forks get use automatically. Other packages need an explicit grant.',
	expiry:
		'An expired secret stays listed, but Kody stops resolving it. This does not revoke the token at the service that issued it.',
}

/**
 * `/features/credentials`: API keys and OAuth connections are one primitive.
 * The safety story reuses the secrets scenes (wrapped in `.secrets`) and the
 * OAuth story reuses the integrations scenes (wrapped in `.integrations`),
 * so each keeps its scene-scoped CSS from `public/feature-scenes/`.
 */
export function CredentialsFeature(handle: Handle) {
	let host: SecretHost = 'approved'
	let sent = false
	let tripShot = 0
	let approval: SecretApproval = 'host'
	let approvalShot = 0
	let account: IntegrationAccountId = 'work'
	let event: IntegrationEventId | null = null
	let heroShot = 0
	let selectedPackage: IntegrationPackageId = 'brief'
	let packageShot = 0
	return () => (
		<div class="study credentials">
			<div class="secrets">
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
							Your agent can use the key.
							<br />
							<em>It can't read it.</em>
						</h1>
						<p class="lead">
							API keys, OAuth connections, and MCP servers live in Kody. Kody
							adds the value to the outgoing request, only for hosts you
							approve. Agents, packages, and logs never see it.
						</p>
						<a class="action" href="/onboarding">
							Connect your agent
						</a>
					</div>
					<div class="ms-trip">
						<SecretsTripScene host={host} sent={sent} shot={tripShot} />
						<div class="controls" aria-label="Example request">
							<button
								type="button"
								aria-pressed={host === 'approved'}
								mix={on('click', () => {
									host = 'approved'
									sent = false
									tripShot += 1
									handle.update()
								})}
							>
								Approved host
							</button>
							<button
								type="button"
								aria-pressed={host === 'blocked'}
								mix={on('click', () => {
									host = 'blocked'
									sent = false
									tripShot += 1
									handle.update()
								})}
							>
								Unapproved host
							</button>
							<button
								type="button"
								class="run"
								id="send-request"
								mix={on('click', () => {
									sent = true
									tripShot += 1
									handle.update()
								})}
							>
								Send example request
							</button>
						</div>
						<p id="secret-result" role="status">
							{tripResultCopy(host, sent)}
						</p>
						<p class="smallprint">
							Illustration only. The approved API receives the credential. The
							agent does not.
						</p>
					</div>
				</div>
				<section class="story-section">
					<div class="story-split ms-access-split">
						<div>
							<h2>
								Approve the destination.
								<br />
								Control the package.
							</h2>
							<p>
								Host approval decides where a credential may be sent. Package
								access decides which saved packages can use it.
							</p>
							<p>
								Packages you write and forks you adopt after reviewing the
								source get use automatically. Other packages need your
								approval.
							</p>
							<div class="controls" aria-label="Explore credential approvals">
								<button
									type="button"
									aria-pressed={approval === 'host'}
									mix={on('click', () => {
										approval = 'host'
										approvalShot += 1
										handle.update()
									})}
								>
									Host approval
								</button>
								<button
									type="button"
									aria-pressed={approval === 'package'}
									mix={on('click', () => {
										approval = 'package'
										approvalShot += 1
										handle.update()
									})}
								>
									Package access
								</button>
								<button
									type="button"
									aria-pressed={approval === 'expiry'}
									mix={on('click', () => {
										approval = 'expiry'
										approvalShot += 1
										handle.update()
									})}
								>
									Expiry
								</button>
							</div>
							<p id="ms-approval-copy" role="status">
								{approvals[approval]}
							</p>
							<a href="/docs/credentials">How credentials stay safe</a>
						</div>
						<SecretsAccessScene approval={approval} shot={approvalShot} />
					</div>
				</section>
				<SecretsVault />
			</div>
			<div class="integrations">
				<section class="story-section">
					<div class="story-split">
						<div>
							<h2>
								If it speaks OAuth,
								<br />
								<em>it works with Kody.</em>
							</h2>
							<p>
								Gmail, Slack, GitHub, or the internal tool your team runs. Any
								service with an OAuth sign-in can connect, through a built-in
								app or one you register.
							</p>
							<p>
								Kody keeps the tokens and refreshes them on its side, so the
								connection stays out of every chat and keeps working.
							</p>
							<a href="/docs/oauth">See how OAuth setup works</a>
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
				</section>
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
			</div>
			<FeatureRelated
				links={[
					{ href: '/integrations/gmail', label: 'Gmail integration' },
					{ href: '/integrations/slack', label: 'Slack integration' },
					{ href: '/integrations/claude', label: 'Claude integration' },
					{ href: '/features/packages', label: 'Reusable packages' },
				]}
			/>
			<div class="feature-start">
				<div>
					<h2>Give your agents access without handing over the keys.</h2>
					<p>
						Store a key or connect an account, approve where it may go, and
						choose which packages can use it.
					</p>
					<p>
						<a href="/docs/credentials">Read the credentials guide</a>
					</p>
				</div>
				<div class="controls">
					<a class="action" href="/onboarding">
						Connect your agent
					</a>
					<BuildWithAgentButton />
				</div>
			</div>
		</div>
	)
}
