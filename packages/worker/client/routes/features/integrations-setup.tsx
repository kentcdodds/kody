import { type Handle } from 'remix/component'
import { IntegrationsSetupScene } from './integrations-scenes.tsx'

export function IntegrationsSetup(_handle: Handle) {
	return () => (
		<section class="story-section">
			<div class="story-split">
				<div>
					<h2>
						Connect it.
						<br />
						Check it.
						<br />
						Choose what uses it.
					</h2>
					<ol class="ia-setup">
						<li>
							<strong>Choose the service.</strong>
							<p>Your agent helps find the right authorization setup.</p>
						</li>
						<li>
							<strong>Finish sign-in.</strong>
							<p>
								Use a built-in app when one is available, or register your own
								provider app.
							</p>
						</li>
						<li>
							<strong>Test a small request.</strong>
							<p>Check the connection before building a workflow around it.</p>
						</li>
					</ol>
					<details class="ia-details">
						<summary>What does registering an app involve?</summary>
						<p>
							Create an OAuth app with the provider, add Kody’s redirect URL,
							and enter the client details in Kody. The provider and permissions
							determine the setup.
						</p>
						<a href="/docs/oauth">Read the OAuth setup guide ↗</a>
					</details>
				</div>
				<div class="ia-lock-scene">
					<span class="example">Example of a restricted connection</span>
					<IntegrationsSetupScene />
					<p>
						Restrict a connection to specific packages. Lock the published
						package too when its behavior needs to stay fixed.
					</p>
					<p class="ia-note">
						A drafts-only package can leave out a send action. Google’s token
						still has the permissions Google issued.
					</p>
					<a href="/docs/locked-gmail-drafts">
						See the complete Gmail draft setup ↗
					</a>
				</div>
			</div>
		</section>
	)
}
