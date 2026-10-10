import { type Handle, on } from 'remix/component'
import { SecretsVault } from './secrets-vault.tsx'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'

const approvals = {
	host: 'An approved destination can receive the credential. An empty host allowlist blocks requests that use secret references.',
	package:
		'Your authored packages and reviewed, adopted forks get use automatically. Other packages need an explicit grant.',
	expiry:
		'An expired secret stays listed, but Kody stops resolving it. This does not revoke the token at the service that issued it.',
}
export function SecretsFeature(handle: Handle) {
	let host: 'approved' | 'blocked' = 'approved'
	let sent = false
	let approval: keyof typeof approvals = 'host'
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
			<div class="boundary ui-stage">
				<div class="envelope ui-window">
					<div class="ui-title">
						<span class="ui-symbol">⌑</span>
						<strong>API credential</strong>
						<span class="ui-state">Stored</span>
					</div>
					<div class="ui-secret-value" aria-label="Secret value hidden">
						••••••••••••••••
					</div>
					<div class="ui-row">
						<small>Agent uses</small>
						<code>{'{{secret:<name>}}'}</code>
					</div>
					<div class="ui-row">
						<small>Allowed host</small>
						<code>api.example.com</code>
					</div>
				</div>
				<div class="gate">
					<svg viewBox="0 0 140 80" aria-hidden="true">
						<path class="ui-request-line" d="M4 40H136" />
						<path d="m124 32 12 8-12 8" />
						<rect x="51" y="24" width="34" height="32" rx="5" />
						<path d="M59 24v-6a9 9 0 0 1 18 0v6" />
					</svg>
					<small>Resolved by Kody</small>
				</div>
				<div class="envelope ui-window">
					<div class="ui-title">
						<span class="ui-symbol">↗</span>
						<strong>API request</strong>
					</div>
					<strong id="destination">
						{host === 'approved' ? 'Approved API host' : 'Unapproved host'}
					</strong>
					<div class="ui-row">
						<small>Authorization</small>
						<span id="ui-auth-status">
							{sent && host === 'approved'
								? 'Added at request boundary'
								: 'Not sent'}
						</span>
					</div>
					<p class="result" id="secret-result" role="status">
						{sent
							? host === 'approved'
								? 'Request sent to the approved host.'
								: 'Blocked. This host is not approved.'
							: 'Ready to send an example request.'}
					</p>
				</div>
			</div>
			<div class="controls">
				<button
					type="button"
					aria-pressed={host === 'approved'}
					mix={on('click', () => {
						host = 'approved'
						sent = false
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
					<div>
						<div class="ui-window ui-policy">
							<div class="ui-title">
								<span class="ui-symbol">⌑</span>
								<strong>Credential access</strong>
								<span class="ui-state">Example</span>
							</div>
							<div
								class={`ms-slip ui-policy-row ${approval === 'host' ? 'ms-active' : ''}`}
							>
								<span>Allowed host</span>
								<code>api.example.com</code>
								<b>✓</b>
							</div>
							<div
								class={`ms-slip ui-policy-row ${approval === 'package' ? 'ms-active' : ''}`}
							>
								<span>Package</span>
								<code>weekly-brief</code>
								<b>✓</b>
							</div>
							<div
								class={`ms-slip ui-policy-row ${approval === 'expiry' ? 'ms-active' : ''}`}
							>
								<span>Expiry</span>
								<span>Checked before use</span>
								<b>✓</b>
							</div>
						</div>
					</div>
				</div>
			</section>
			<SecretsVault />
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
				<BuildWithAgentButton />
			</div>
		</div>
	)
}
