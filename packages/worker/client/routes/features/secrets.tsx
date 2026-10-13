import { type Handle, on } from 'remix/component'
import { SecretsVault } from './secrets-vault.tsx'
import { FeatureRelated } from './feature-related.tsx'
import {
	SecretsAccessScene,
	SecretsTripScene,
	type SecretApproval,
	type SecretHost,
} from './secrets-scenes.tsx'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'

const approvals = {
	host: 'An approved destination can receive the credential. An empty host allowlist blocks requests that use secret references.',
	package:
		'Your authored packages and reviewed, adopted forks get use automatically. Other packages need an explicit grant.',
	expiry:
		'An expired secret stays listed, but Kody stops resolving it. This does not revoke the token at the service that issued it.',
}
export function SecretsFeature(handle: Handle) {
	let host: SecretHost = 'approved'
	let sent = false
	let tripShot = 0
	let approval: SecretApproval = 'host'
	let approvalShot = 0
	return () => (
		<div class="study secrets">
			<img
				class="feature-orb"
				src="/images/lantern/kody-primitives-orb-secrets.webp"
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
				Give your agent the API access it needs. Kody sends the credential only
				to hosts you approve.
			</p>
			<a class="action" href="/onboarding">
				Connect your agent
			</a>
			<SecretsTripScene host={host} sent={sent} shot={tripShot} />
			<div class="controls">
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
			<p class="smallprint">
				Illustration only. The approved API receives the credential. The agent
				does not.
			</p>
			<section class="story-section">
				<div class="story-split">
					<div>
						<h2>
							Approve the destination.
							<br />
							Control the package.
						</h2>
						<p>
							Host approval decides where a secret may be sent. Package access
							decides which saved packages can use it.
						</p>
						<p>
							Packages you write and forks you adopt after reviewing the source
							get use automatically. Other packages need your approval.
						</p>
						<div class="controls" aria-label="Explore secret approvals">
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
						<a href="/docs/secrets">How approvals work</a>
					</div>
					<SecretsAccessScene approval={approval} shot={approvalShot} />
				</div>
			</section>
			<SecretsVault />
			<FeatureRelated
				links={[
					{ href: '/features/integrations', label: 'Service connections' },
					{ href: '/features/packages', label: 'Reusable packages' },
				]}
			/>
			<div class="feature-start">
				<div>
					<h2>Give your agent access to the work.</h2>
					<p>
						Store a credential, approve its destination, and choose which
						packages can use it.
					</p>
					<p>
						<a href="/docs/secrets">Read the guide</a>
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
