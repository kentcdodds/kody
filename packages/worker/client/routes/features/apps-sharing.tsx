import { type Handle, on } from 'remix/component'
import { type Brief } from './apps-intake.tsx'
import { AppsShareScene, type AccessRole } from './apps-scenes.tsx'

const roles = {
	Use: 'Can read the source and run the package.',
	Contribute: 'Can read the source, run, and edit the package.',
	Manage:
		'Can read the source, run, edit, publish, delete, and manage access to the package.',
}
export function AppsSharing(
	handle: Handle<{
		preview: Brief
	}>,
) {
	let role: AccessRole = 'Use'
	let shot = 0
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
									) {
										role = next
										shot += 1
									}
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
					<AppsShareScene
						role={role}
						brief={handle.props.preview}
						shot={shot}
					/>
					<p class="ia-note">Package access does not reveal secret values.</p>
				</div>
			</div>
		</section>
	)
}
