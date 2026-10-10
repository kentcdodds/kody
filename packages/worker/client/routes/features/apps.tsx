import { type Handle, on } from 'remix/component'
import { AppsSharing } from './apps-sharing.tsx'
import { AppsIntake, type Brief } from './apps-intake.tsx'
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
		view = 'detail'
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
					<div class="appwindow ui-window">
						<div class="bar">
							<span>
								<span class="ui-browser-dots" aria-hidden="true">
									● ● ●
								</span>{' '}
								project-intake
							</span>
							<span>Demo app</span>
						</div>
						<div class="appbody" id="intake-demo">
							<div class="tabs" aria-label="Demo views">
								<button
									type="button"
									aria-pressed={view === 'form'}
									mix={on('click', () => {
										view = 'form'
										handle.update()
									})}
								>
									Intake form
								</button>
								<button
									type="button"
									aria-pressed={view === 'records'}
									mix={on('click', () => {
										view = 'records'
										handle.update()
									})}
								>
									Saved briefs
								</button>
							</div>
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
								<div>
									<h3>Saved briefs</h3>
									{recordList()}
								</div>
							) : (
								<div>
									<h3>{draft.name}</h3>
									<p>
										{draft.kind} · {draft.deadline}
									</p>
									<p>{draft.copy}</p>
									<p role="status">
										{saved ? 'Saved in this demo' : 'Example brief'}
									</p>
									<button
										type="button"
										class="run"
										mix={on('click', () => {
											view = 'form'
											handle.update()
										})}
									>
										Edit brief
									</button>
									<button type="button" class="run" mix={on('click', newBrief)}>
										New brief
									</button>
								</div>
							)}
						</div>
					</div>
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
						<svg class="ia-return-art" viewBox="0 0 560 150" aria-hidden="true">
							<path d="M95 100C95 10 460 10 460 100" class="ia-track" />
							<path
								d="m444 85 16 17 15-18"
								fill="none"
								stroke="var(--accent)"
								stroke-width="3"
							/>
							<g transform="translate(68 70) rotate(-8)">
								<rect
									width="64"
									height="77"
									rx="6"
									fill="var(--selected)"
									stroke="var(--accent)"
								/>
								<path
									d="M16 22h32M16 34h32M16 46h22"
									stroke="var(--accent)"
									stroke-width="3"
								/>
							</g>
							<g transform="translate(430 75) rotate(7)">
								<rect
									width="64"
									height="77"
									rx="6"
									fill="var(--surface)"
									stroke="var(--accent)"
								/>
								<path
									d="m15 38 12 12 23-25"
									fill="none"
									stroke="var(--accent)"
									stroke-width="4"
								/>
							</g>
						</svg>
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
			<AppsSharing />
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
