import { on, type Handle } from 'remix/component'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'
import { PackagePublishArt, PackageShareArt } from './packages-art.tsx'

export function PackagesFeature(handle: Handle) {
	let tab = 'intent'
	let questions = false
	let previewQuestions = false
	let previewed = false
	let live = false
	let sharing = 'share'
	let access = 'use'
	let copyEdited = false
	let status = 'Example package. The published brief has no open questions.'
	return () => (
		<div class="study packages">
			<div class="split">
				<div>
					<img
						class="feature-orb"
						src="/images/lantern/kody-primitives-orb-packages.webp"
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Keep the software
						<br />
						<em>your agent builds.</em>
					</h1>
					<p class="lead">
						Turn a useful one-off into a package you own. Run it again, change
						it, or give someone access to the work.
					</p>
					<div class="controls">
						<a class="action" href="/onboarding">
							Connect your agent
						</a>
						<a href="/community">Explore community packages</a>
					</div>
				</div>
				<div>
					<span class="example">Illustrative package workbench</span>
					<div class="bench ui-window">
						<div class="spine">
							<span>
								<span class="ui-symbol">◇</span> weekly-brief
							</span>
							<span class="ui-state">Published</span>
						</div>
						<div class="controls" aria-label="Package contents">
							{['Intent', 'Source', 'Result'].map((label) => (
								<button
									key={label}
									type="button"
									aria-pressed={tab === label.toLowerCase()}
									mix={on('click', () => {
										tab = label.toLowerCase()
										handle.update()
									})}
								>
									{label}
								</button>
							))}
						</div>
						<div class="contents" id="package-content" aria-live="polite">
							{tab === 'intent' ? (
								<p>
									Collect the project updates I choose and turn them into a
									weekly brief.
								</p>
							) : tab === 'source' ? (
								<>
									<pre>
										{'README.md\nAGENTS.md\npackage.json\nsrc/brief.ts'}
									</pre>
									<a href="/docs/package-skills">
										Packages can also include Agent Skills
									</a>
								</>
							) : (
								<>
									<h3>Weekly brief</h3>
									<p>
										Orchard: design review is ready.
										<br />
										Fieldwork: kickoff is booked.
									</p>
									{live && <p>Open question: Who approves the final copy?</p>}
								</>
							)}
						</div>
						<div class="stamp">
							<small id="publish-state">Current published code</small>
							<a href="#package-publishing">Try a source change ↓</a>
						</div>
					</div>
				</div>
			</div>
			<section
				class="story-section story-split pt-publish"
				id="package-publishing"
			>
				<div>
					<h2>
						Change the source.
						<br />
						Choose when it runs.
					</h2>
					<p>
						Your package has a repo. Your agent can edit the source and check
						the result. Publishing makes that change the code your package runs.
					</p>
					<div class="pt-options">
						<label>
							<input
								type="checkbox"
								checked={questions}
								mix={on('change', (event) => {
									questions = event.currentTarget.checked
									previewed = false
									status =
										'Source changed. Preview it to compare with the current published output.'
									handle.update()
								})}
							/>{' '}
							Include open questions
						</label>
						<button
							type="button"
							mix={on('click', () => {
								previewed = true
								previewQuestions = questions
								status = questions
									? 'Example output includes open questions. The published output has not changed.'
									: 'Example output has no open questions. The published output has not changed.'
								handle.update()
							})}
						>
							Preview proposed change
						</button>
						<button
							type="button"
							disabled={!previewed || questions === live}
							mix={on('click', () => {
								live = questions
								status = 'Example change is now published.'
								handle.update()
							})}
						>
							Publish example change
						</button>
					</div>
					<p id="pt-publish-status" class="pt-status" aria-live="polite">
						{status}
					</p>
					<a href="/docs/package-authoring">How packages are built ↗</a>
				</div>
				<div class="pt-proof">
					<PackagePublishArt />
					<div class="pt-sheets">
						<article>
							<small>Proposed output</small>
							<h3>Weekly brief</h3>
							<p>
								Orchard: design review is ready.
								<br />
								Fieldwork: kickoff is booked.
							</p>
							<p hidden={!previewQuestions}>
								Open question: Who approves the final copy?
							</p>
						</article>
						<article>
							<small>Current published output</small>
							<h3>Weekly brief</h3>
							<p>
								Orchard: design review is ready.
								<br />
								Fieldwork: kickoff is booked.
							</p>
							<p hidden={!live}>Open question: Who approves the final copy?</p>
						</article>
					</div>
				</div>
			</section>
			<section class="story-section story-split pt-sharing">
				<div>
					<h2>
						Share the work.
						<br />
						Or hand over a copy.
					</h2>
					<p>
						Give someone access to one live package. Fork a public package when
						they should own and change their own copy.
					</p>
					<div class="controls">
						<button
							type="button"
							aria-pressed={sharing === 'share'}
							mix={on('click', () => {
								sharing = 'share'
								handle.update()
							})}
						>
							Share access
						</button>
						<button
							type="button"
							aria-pressed={sharing === 'fork'}
							mix={on('click', () => {
								sharing = 'fork'
								handle.update()
							})}
						>
							Make a copy
						</button>
					</div>
					<div hidden={sharing === 'fork'}>
						<label for="pt-access">Access level</label>
						<select
							id="pt-access"
							value={access}
							mix={on('change', (event) => {
								access = event.currentTarget.value
								handle.update()
							})}
						>
							<option value="use">Use: read and run</option>
							<option value="contribute">
								Contribute: read, run, and edit
							</option>
							<option value="manage">
								Manage: edit, publish, delete, and manage access
							</option>
						</select>
					</div>
					<button
						type="button"
						hidden={sharing !== 'fork'}
						mix={on('click', () => {
							copyEdited = !copyEdited
							handle.update()
						})}
					>
						Change the copy’s focus
					</button>
					<p id="pt-share-status" class="pt-status" aria-live="polite">
						{sharing === 'fork'
							? 'Two owners, two separate packages. Changes to the copy are its owner’s to make.'
							: access === 'manage'
								? 'They can read, run, edit, publish, delete, and manage access. Runs stay in the owner’s organization.'
								: access === 'contribute'
									? 'They can read, run, and edit the same package. Runs stay in the owner’s organization.'
									: 'They can read the source and run the same package. Runs stay in the owner’s organization.'}
					</p>
					<a href="/docs/package-sharing">Package sharing and access ↗</a>
				</div>
				<div class="pt-share-art">
					<PackageShareArt sharing={sharing} copyEdited={copyEdited} />
				</div>
			</section>
			<div class="feature-start">
				<div>
					<h2>Start with work you already repeat.</h2>
					<p>
						Keep a reporting tool, a recurring check, or a small app as software
						you can use again.
					</p>
					<p>
						<a href="/docs/package-lifecycle">Read the guide</a>
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
