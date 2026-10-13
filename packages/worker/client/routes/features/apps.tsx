import { type Handle, on } from 'remix/component'
import { AppsSharing } from './apps-sharing.tsx'
import { AppsIntake, type Brief } from './apps-intake.tsx'
import {
	AppsHeroScene,
	AppsReturnScene,
	tomorrowBrief,
} from './apps-scenes.tsx'
import { FeatureRelated } from './feature-related.tsx'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'

const initialBrief: Brief = {
	id: 0,
	name: 'Autumn launch',
	kind: 'Website',
	deadline: 'October 28',
	copy: 'A product page for the new collection.',
}
export function AppsFeature(handle: Handle) {
	let draft = { ...initialBrief }
	let records: Brief[] = [{ ...initialBrief }]
	let view: 'form' | 'records' | 'detail' = 'form'
	let opened: Brief | undefined
	let saved = false
	let nextId = 1
	let promptShot = 0
	let saveShot = 0
	let flyingName = initialBrief.name
	function focusSavedBriefHeading() {
		queueMicrotask(() => {
			document.getElementById('saved-brief-heading')?.focus()
		})
	}
	function save() {
		if (!draft.name.trim()) return
		draft = { ...draft, name: draft.name.trim() }
		const exists = records.some((record) => record.id === draft.id)
		records = exists
			? records.map((record) =>
					record.id === draft.id ? { ...draft } : record,
				)
			: [...records, { ...draft }]
		opened = { ...draft }
		saved = true
		flyingName = draft.name
		saveShot += 1
		view = 'detail'
		handle.update()
		focusSavedBriefHeading()
	}
	function showForm() {
		view = 'form'
		promptShot += 1
		handle.update()
	}
	function showRecords() {
		view = 'records'
		promptShot += 1
		handle.update()
	}
	function newBrief() {
		draft = {
			id: nextId++,
			name: '',
			kind: 'Website',
			deadline: 'No deadline',
			copy: '',
		}
		view = 'form'
		handle.update()
	}
	function recordList() {
		return records.map((record) => (
			<button
				key={record.id}
				class="ia-record"
				type="button"
				mix={on('click', () => {
					opened = { ...record }
					draft = { ...record }
					view = 'detail'
					handle.update()
					focusSavedBriefHeading()
				})}
			>
				<span>
					<strong>{record.name}</strong>
					<small>
						{record.kind} · {record.deadline}
					</small>
				</span>
				<span>Open brief ↗</span>
			</button>
		))
	}
	return () => (
		<div class="study apps">
			<div class="split">
				<div>
					<img
						class="feature-orb"
						src="/images/lantern/kody-primitives-orb-apps.webp"
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Give your work
						<br />
						<em>a place to happen.</em>
					</h1>
					<p class="lead">
						Ask your agent for a tool that fits the job. Kody hosts the app,
						keeps its data, and connects it to the packages you already use.
					</p>
					<a class="action" href="/onboarding">
						Build an app
					</a>
				</div>
				<div>
					<span class="example">
						Interactive demo, saved only in this page session
					</span>
					<AppsHeroScene
						promptShot={promptShot}
						saveShot={saveShot}
						count={records.length}
						flyingName={flyingName}
						formPressed={view === 'form'}
						recordsPressed={view === 'records'}
						onShowForm={showForm}
						onShowRecords={showRecords}
					>
						{view === 'form' ? (
							<AppsIntake
								draft={draft}
								onSave={save}
								onChange={(next) => {
									draft = next
									handle.update()
								}}
							/>
						) : view === 'records' ? (
							<div class="pw-apx-records">
								<h3>Saved briefs</h3>
								{recordList()}
							</div>
						) : (
							<div class="pw-apx-detail">
								<h3 id="saved-brief-heading" tabIndex={-1}>
									{draft.name}
								</h3>
								<p>
									{draft.kind} · {draft.deadline}
								</p>
								<p>{draft.copy}</p>
								<p role="status">
									{saved ? 'Saved in this demo' : 'Example brief'}
								</p>
								<div class="pw-apx-actions">
									<button
										type="button"
										class="run"
										mix={on('click', () => {
											view = 'form'
											promptShot += 1
											handle.update()
										})}
									>
										Edit brief
									</button>
									<button
										type="button"
										class="run"
										mix={on('click', () => {
											promptShot += 1
											newBrief()
										})}
									>
										New brief
									</button>
								</div>
							</div>
						)}
					</AppsHeroScene>
					<p class="visually-hidden" aria-live="polite">
						{saveShot > 0
							? `${flyingName} saved. ${records.length} in Saved briefs.`
							: ''}
					</p>
				</div>
			</div>
			<section class="story-section">
				<div class="story-split">
					<div>
						<h2>
							Open it.
							<br />
							Do the thing.
							<br />
							Come back tomorrow.
						</h2>
						<p>
							A brief to collect. A project to update. A small calculator you
							use every week. Give the work a screen of its own, with data that
							stays with the package.
						</p>
						<a href="/docs/package-apps">How app data works ↗</a>
					</div>
					<div class="ia-return-scene">
						<AppsReturnScene records={records} openedId={opened?.id} />
						<p class="visually-hidden" aria-live="polite">
							{`Tomorrow, ${records.map((record) => record.name).join(', ')} ${records.length === 1 ? 'is' : 'are'} still saved, and ${tomorrowBrief.name} was added.`}
						</p>
						<div class="ia-saved-head">
							<h3>Saved briefs</h3>
							<span>Page-session demo</span>
						</div>
						<div>{recordList()}</div>
						<p class="ia-note" role="status">
							{saved
								? 'Saved only in this page session.'
								: 'Open the example, or save your own brief above.'}
						</p>
						{opened && (
							<div class="ia-record-detail">
								<h3>{opened.name}</h3>
								<p>
									{opened.kind} · {opened.deadline}
								</p>
								<p>{opened.copy}</p>
								<button
									type="button"
									class="run"
									mix={on('click', () => {
										if (opened) {
											draft = { ...opened }
											view = 'form'
											promptShot += 1
											handle.update()
										}
									})}
								>
									Edit this brief
								</button>
								<a href="#intake-demo">Go to intake form ↑</a>
							</div>
						)}
					</div>
				</div>
			</section>
			<AppsSharing preview={opened ?? records[0] ?? initialBrief} />
			<FeatureRelated
				links={[
					{ href: '/features/packages', label: 'Reusable packages' },
					{ href: '/features/triggers', label: 'Triggers and automation' },
				]}
			/>
			<div class="feature-start">
				<div>
					<h2>Build the tool you would open every week.</h2>
					<p>
						Start with a small job, a project intake form, a review queue, or a
						tracker with data worth keeping.
					</p>
					<p>
						<a href="/docs/package-apps">Read the guide</a>
					</p>
				</div>
				<div>
					<a class="action" href="/onboarding">
						Build an app
					</a>
					<BuildWithAgentButton />
				</div>
			</div>
		</div>
	)
}
