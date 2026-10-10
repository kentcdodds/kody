import { type Handle, on } from 'remix/component'
import { FeatureRelated } from './feature-related.tsx'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'

const notes = {
	writing: [
		'Writing preference',
		'Lead with the decision.',
		'Draft my weekly update.',
		"We're moving ahead with the new design. Review starts Thursday.",
	],
	projects: [
		'Project name',
		'Website refresh: Orchard.',
		'Help me outline an Orchard update.',
		'Orchard update: what changed on the website, what needs review, and what comes next.',
	],
	people: [
		'People',
		'Morgan is my accountant.',
		'Draft a question for my accountant.',
		'Hi Morgan, which documents should I have ready before our next meeting?',
	],
}
export function MemoryFeature(handle: Handle) {
	let nextAgent = true
	let note: keyof typeof notes = 'writing'
	let updated = false
	return () => (
		<div class="study memory">
			<div class="split">
				<div>
					<img
						class="feature-orb"
						src="/images/lantern/kody-primitives-orb-memory.webp"
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						New agent.
						<br />
						<em>Same you.</em>
					</h1>
					<p class="lead">
						Save the facts and preferences you keep repeating. Bring them to
						your next connected agent.
					</p>
					<a class="action" href="/onboarding">
						Connect your agent
					</a>
					<div class="controls" aria-label="Example agent">
						<button
							type="button"
							aria-pressed={!nextAgent}
							mix={on('click', () => {
								nextAgent = false
								handle.update()
							})}
						>
							Save in one agent
						</button>
						<button
							type="button"
							aria-pressed={nextAgent}
							mix={on('click', () => {
								nextAgent = true
								handle.update()
							})}
						>
							Try another agent
						</button>
					</div>
				</div>
				<div class="memory-stack ui-stage">
					<span class="example">
						Example memory, shared between connected agents
					</span>
					<div class="note ui-window">
						<div class="ui-title">
							<span class="ui-symbol">≡</span>
							<strong>Memories</strong>
							<span class="ui-state">Saved</span>
						</div>
						<div class="ui-memory-entry">
							<small>Writing preference</small>
							<blockquote>
								Lead with the decision.
								<br />
								Keep updates short.
							</blockquote>
							<footer>
								project updates <span>preference</span>
							</footer>
						</div>
					</div>
					<div class="ui-transfer" aria-hidden="true">
						<span></span>
						<i>↓</i>
						<span></span>
					</div>
					<div class="conversation ui-window" aria-live="polite">
						<h3 id="memory-agent">
							{nextAgent ? 'Your next connected agent' : 'Your first agent'}
						</h3>
						<p id="memory-text">
							{nextAgent
								? 'Help me write a project update using my saved preference.'
								: 'Remember this for my project updates.'}
						</p>
						<p id="memory-result">
							{nextAgent
								? 'Relevant memory: Lead with the decision. Keep updates short.'
								: 'Saved your writing preference in Kody.'}
						</p>
						{nextAgent && (
							<p>
								We're moving ahead with the new design. Review starts Thursday.
							</p>
						)}
					</div>
				</div>
			</div>
			<section class="story-section">
				<div class="story-split">
					<div>
						<h2>A little context goes a long way.</h2>
						<p>
							A writing preference. A project name. The person you mean when you
							say “my accountant.” Keep the details worth carrying into the next
							conversation.
						</p>
						<div class="controls" aria-label="Choose an example memory">
							<button
								type="button"
								aria-pressed={note === 'writing'}
								mix={on('click', () => {
									note = 'writing'
									handle.update()
								})}
							>
								Writing
							</button>
							<button
								type="button"
								aria-pressed={note === 'projects'}
								mix={on('click', () => {
									note = 'projects'
									handle.update()
								})}
							>
								Projects
							</button>
							<button
								type="button"
								aria-pressed={note === 'people'}
								mix={on('click', () => {
									note = 'people'
									handle.update()
								})}
							>
								People
							</button>
						</div>
						<details class="ms-details">
							<summary>How does the right note surface?</summary>
							<p>
								Kody returns a small amount of relevant context when your
								connected agent searches or runs work with a memory hint.
								Memories belong to your account.
							</p>
							<a href="/docs/memory">How memory retrieval works</a>
						</details>
					</div>
					<div class="ms-memory-index">
						<div class="ms-moving-note ui-window ui-record">
							<div class="ui-title">
								<span class="ui-symbol">≡</span>
								<strong id="ms-note-kind">{notes[note][0]}</strong>
								<span class="ui-state">Saved</span>
							</div>
							<p id="ms-note-line">{notes[note][1]}</p>
							<div class="ui-record-meta">Available to connected agents</div>
						</div>
						<div class="ui-transfer" aria-hidden="true">
							<i>↓</i>
						</div>
						<div class="ms-task-output" aria-live="polite">
							<span class="example">Example draft</span>
							<h3 id="ms-task">{notes[note][2]}</h3>
							<p id="ms-draft">{notes[note][3]}</p>
						</div>
					</div>
				</div>
			</section>
			<section class="story-section">
				<div class="story-split">
					<div class="ms-edit-scene">
						<div class="ui-history">
							<span>Find existing preference</span>
							<span aria-hidden="true">→</span>
							<span>Update saved entry</span>
						</div>
						<div class="ms-live-note">
							<small>Writing preference · local example</small>
							<blockquote id="ms-updated-note">
								{updated
									? 'Include the decision, the reason, and the next step.'
									: 'Lead with the decision. Keep updates short.'}
							</blockquote>
						</div>
						<p class="ms-update-status" id="ms-update-status" role="status">
							{updated
								? 'Found your existing writing preference. Updated it to include the decision, the reason, and the next step.'
								: 'The original preference is saved.'}
						</p>
					</div>
					<div>
						<h2>
							Changed your mind?
							<br />
							Change the memory.
						</h2>
						<p>
							Ask your agent to update what it remembers. It checks related
							memories first, then tells you what changed.
						</p>
						<div class="controls">
							<button
								type="button"
								class="run"
								id="ms-update"
								disabled={updated}
								mix={on('click', () => {
									updated = true
									handle.update()
								})}
							>
								Make updates more detailed
							</button>
							<button
								type="button"
								id="ms-reset"
								mix={on('click', () => {
									updated = false
									handle.update()
								})}
							>
								Reset example
							</button>
						</div>
						<p>
							Search your memories, remove what you no longer need, or download
							a JSON copy.
						</p>
						<a href="/docs/memory">How to manage and export memories</a>
					</div>
				</div>
				<div class="ms-next-agent">
					<h3>Take it to your next agent.</h3>
					<div class="ms-prompt-pair">
						<div>
							<label for="ms-save-prompt">In your first connected agent</label>
							<textarea
								id="ms-save-prompt"
								readOnly
								value="Save this in Kody memory: for project updates, lead with the decision and keep it short."
							/>
						</div>
						<div>
							<label for="ms-lookup-prompt">In another connected agent</label>
							<textarea
								id="ms-lookup-prompt"
								readOnly
								value="Look up my project-update preference in Kody and help me draft an update."
							/>
						</div>
					</div>
				</div>
			</section>
			<FeatureRelated
				links={[
					{
						href: '/use-cases/shared-agent-memory',
						label: 'Shared agent memory use case',
					},
					{ href: '/features/integrations', label: 'Service connections' },
				]}
			/>
			<div class="feature-start">
				<a href="/docs/memory">Read the memory guide</a>
				<BuildWithAgentButton />
			</div>
		</div>
	)
}
