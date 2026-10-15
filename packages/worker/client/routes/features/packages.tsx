import { on, type Handle } from 'remix/component'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'
import { FeatureRelated } from './feature-related.tsx'
import {
	PackagePublishScene,
	PackageShareScene,
	PackageWorkbenchScene,
	type PackageAccess,
	type PackageSharing,
	type PackageTab,
} from './packages-scenes.tsx'

const examplePackageSource = 'README.md\nAGENTS.md\npackage.json\nsrc/brief.ts'

const packageTabs = ['Intent', 'Source', 'Result'] as const
type PackageTabLabel = (typeof packageTabs)[number]

function tabFromLabel(label: PackageTabLabel): PackageTab {
	switch (label) {
		case 'Intent':
			return 'intent'
		case 'Source':
			return 'source'
		case 'Result':
			return 'result'
		default: {
			const exhaustive: never = label
			return exhaustive
		}
	}
}

function tabStatus(tab: PackageTab) {
	switch (tab) {
		case 'intent':
			return 'Showing the request that became the weekly-brief package.'
		case 'source':
			return 'Showing the package source in src/brief.ts.'
		case 'result':
			return 'Showing the result of running weekly-brief.'
		default: {
			const exhaustive: never = tab
			return exhaustive
		}
	}
}

function accessFromValue(value: string): PackageAccess {
	switch (value) {
		case 'use':
		case 'contribute':
		case 'manage':
			return value
		default:
			return 'use'
	}
}

export function PackagesFeature(handle: Handle) {
	let tab: PackageTab = 'intent'
	let heroShot = 0
	let questions = false
	let previewQuestions = false
	let previewed = false
	let live = false
	let publishShot = 0
	let version = 1
	let sharing: PackageSharing = 'share'
	let access: PackageAccess = 'use'
	let copyEdited = false
	let forkArtStatus = ''
	let shareShot = 0
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
							{packageTabs.map((label) => {
								const next = tabFromLabel(label)
								return (
									<button
										key={label}
										type="button"
										aria-pressed={tab === next}
										mix={on('click', () => {
											tab = next
											heroShot += 1
											handle.update()
										})}
									>
										{label}
									</button>
								)
							})}
						</div>
						<p class="visually-hidden" aria-live="polite">
							{tabStatus(tab)}
						</p>
						<div class="contents" id="package-content">
							<PackageWorkbenchScene tab={tab} live={live} shot={heroShot} />
							{tab === 'source' ? (
								<a class="pw-pkg-skills" href="/docs/package-skills">
									Packages can also include Agent Skills
								</a>
							) : null}
						</div>
						{/* Tab panels need JS; keep example source readable without it. */}
						<noscript>
							<div class="contents" id="package-source-fallback">
								<small>Example source</small>
								<pre>{examplePackageSource}</pre>
							</div>
						</noscript>
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
									publishShot += 1
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
								publishShot += 1
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
								version += 1
								publishShot += 1
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
					<PackagePublishScene
						questions={questions}
						previewed={previewed}
						previewQuestions={previewQuestions}
						live={live}
						version={version}
						shot={publishShot}
					/>
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
								shareShot += 1
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
								shareShot += 1
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
								access = accessFromValue(event.currentTarget.value)
								shareShot += 1
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
							forkArtStatus = 'Change the copy’s focus'
							shareShot += 1
							handle.update()
						})}
					>
						Change the copy’s focus
					</button>
					<p class="visually-hidden" aria-live="polite">
						{forkArtStatus}
					</p>
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
					<PackageShareScene
						sharing={sharing}
						access={access}
						copyEdited={copyEdited}
						shot={shareShot}
					/>
				</div>
			</section>
			<FeatureRelated
				links={[
					{ href: '/features/triggers', label: 'Triggers and automation' },
					{ href: '/features/apps', label: 'Package apps' },
					{ href: '/features/credentials', label: 'Credentials' },
				]}
			/>
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
