import { type Handle, on } from 'remix/component'
const roles = {
	Use: 'Can read the source and run the package.',
	Contribute: 'Can read the source, run, and edit the package.',
	Manage:
		'Can read the source, run, edit, publish, delete, and manage access to the package.',
}
export function AppsSharing(handle: Handle) {
	let role: keyof typeof roles = 'Use'
	return () => (
		<section class="story-section">
			<div class="story-split">
				<div>
					<h2>
						Share the tool
						<br />
						you made.
					</h2>
					<p>
						Give someone access to the package behind your app. Choose whether
						they can run it, help build it, or manage it with you.
					</p>
					<a href="/docs/package-sharing">Share a package ↗</a>
				</div>
				<div class="ia-share-scene">
					<span class="example">Example package access</span>
					<div class="ia-collaborator">
						<span class="ia-avatar" aria-hidden="true">
							M
						</span>
						<div>
							<strong>Morgan</strong>
							<small>project-intake</small>
						</div>
						<label>
							<span class="ia-sr">Morgan’s access</span>
							<select
								value={role}
								mix={on('change', (event) => {
									const next = event.currentTarget.value
									if (
										next === 'Use' ||
										next === 'Contribute' ||
										next === 'Manage'
									)
										role = next
									handle.update()
								})}
							>
								<option>Use</option>
								<option>Contribute</option>
								<option>Manage</option>
							</select>
						</label>
					</div>
					<p class="ia-role-description" id="ia-role-description" role="status">
						{roles[role]}
					</p>
					<svg class="ia-share-art" viewBox="0 0 560 185" aria-hidden="true">
						<path class="ia-track" d="M80 140H480" />
						<g class="ia-capability">
							<circle cx="80" cy="80" r="36" />
							<path d="m66 80 10 10 20-23" />
							<text x="80" y="174" text-anchor="middle">
								Read + run
							</text>
						</g>
						<g class="ia-capability" opacity={role === 'Use' ? 0.3 : 1}>
							<circle cx="280" cy="80" r="36" />
							<path d="m265 94 6-18 18-18 12 12-18 18Z" />
							<text x="280" y="174" text-anchor="middle">
								Edit
							</text>
						</g>
						<g class="ia-capability" opacity={role === 'Manage' ? 1 : 0.3}>
							<circle cx="480" cy="80" r="36" />
							<path d="M480 95V64m-12 12 12-12 12 12M464 97h32" />
							<text x="480" y="174" text-anchor="middle">
								Publish + access
							</text>
						</g>
					</svg>
					<p class="ia-note">Package access does not reveal secret values.</p>
				</div>
			</div>
		</section>
	)
}
