import { type Handle, on } from 'remix/component'
import { FeatureRelated } from './feature-related.tsx'
import {
	MemoryEditScene,
	MemoryHeroScene,
	MemoryIndexScene,
	type MemoryNote,
	type MemoryNoteId,
} from './memory-scenes.tsx'
import { BuildWithAgentButton } from '#client/build-with-agent-button.tsx'

const notes: ReadonlyArray<MemoryNote> = [
	{
		id: 'writing',
		kind: 'Writing preference',
		fact: 'Lead with the decision.',
		task: 'Draft my weekly update.',
		draft: "We're moving ahead with the new design. Review starts Thursday.",
	},
	{
		id: 'projects',
		kind: 'Project name',
		fact: 'Website refresh: Orchard.',
		task: 'Help me outline an Orchard update.',
		draft:
			'Orchard update: what changed on the website, what needs review, and what comes next.',
	},
	{
		id: 'people',
		kind: 'People',
		fact: 'Morgan is my accountant.',
		task: 'Draft a question for my accountant.',
		draft:
			'Hi Morgan, which documents should I have ready before our next meeting?',
	},
]
const originalWritingPreference = 'Lead with the decision. Keep updates short.'
const updatedWritingPreference =
	'Include the decision, the reason, and the next step.'
const originalProjectDraft =
	"We're moving ahead with the new design. Review starts Thursday."
const updatedProjectDraft =
	"We're moving ahead with the new design. The review feedback is solid. Next step: begin the review Thursday."

export function MemoryFeature(handle: Handle) {
	let nextAgent = true
	let heroShot = 0
	let note: MemoryNoteId = 'writing'
	let updated = false
	let editShot = 0
	return () => {
		const writingPreference = updated
			? updatedWritingPreference
			: originalWritingPreference
		const selectedNote = notes.find((entry) => entry.id === note) ?? notes[0]!
		return (
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
									heroShot += 1
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
									heroShot += 1
									handle.update()
								})}
							>
								Try another agent
							</button>
						</div>
					</div>
					<div class="memory-stack">
						<span class="example">
							Example memory, shared between connected agents
						</span>
						<MemoryHeroScene
							mode={nextAgent ? 'recall' : 'save'}
							preference={writingPreference}
							draft={updated ? updatedProjectDraft : originalProjectDraft}
							shot={heroShot}
						/>
						<p class="visually-hidden" aria-live="polite">
							{nextAgent
								? `Your next connected agent found your saved preference: ${writingPreference}`
								: 'Your first agent saved your writing preference in Kody.'}
						</p>
					</div>
				</div>
				<section class="story-section">
					<div class="story-split">
						<div>
							<h2>A little context goes a long way.</h2>
							<p>
								A writing preference. A project name. The person you mean when
								you say “my accountant.” Keep the details worth carrying into
								the next conversation.
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
							<MemoryIndexScene notes={notes} selected={note} />
							<p class="visually-hidden" aria-live="polite">
								{`${selectedNote.kind}: ${selectedNote.fact} Example draft: ${selectedNote.draft}`}
							</p>
						</div>
					</div>
				</section>
				<section class="story-section">
					<div class="story-split">
						<div class="ms-edit-scene">
							<MemoryEditScene
								original={originalWritingPreference}
								updated={updatedWritingPreference}
								isUpdated={updated}
								shot={editShot}
							/>
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
										editShot += 1
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
										editShot += 1
										handle.update()
									})}
								>
									Reset example
								</button>
							</div>
							<p>
								Search your memories, remove what you no longer need, or
								download a JSON copy.
							</p>
							<a href="/docs/memory">How to manage and export memories</a>
						</div>
					</div>
					<div class="ms-next-agent">
						<h3>Take it to your next agent.</h3>
						<div class="ms-prompt-pair">
							<div>
								<label for="ms-save-prompt">
									In your first connected agent
								</label>
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
}
