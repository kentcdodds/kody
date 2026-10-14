import { type Handle } from 'remix/component'
import {
	at,
	icon,
	PrimitiveWidgetFrame,
	wire,
	wires,
} from '#client/primitive-widget-parts.tsx'

/**
 * `/features/memory` scenes. The page's own buttons drive them; each scene
 * holds the visible example text, and `public/feature-scenes/memory.css`
 * animates it. A keyed `.pw-run` restarts the timeline whenever the example
 * changes, so every click replays the story from the top.
 */

export type MemoryHeroMode = 'save' | 'recall'

const heroHeight = 250
const heroTop = heroHeight * 0.4
const heroBottom = heroHeight * 0.6
const chatRight = 46
const cardLeft = 63
const chatEdge = (chatRight / 100) * 360
const cardEdge = (cardLeft / 100) * 360

export function MemoryHeroScene(
	handle: Handle<{
		mode: MemoryHeroMode
		preference: string
		draft: string
		shot: number
	}>,
) {
	return () => {
		const { mode, preference, draft, shot } = handle.props
		const recall = mode === 'recall'
		return (
			<PrimitiveWidgetFrame
				id="memory"
				size="full"
				height={heroHeight}
				class="pw-scene-mem-hero"
				stack
			>
				<div class="pw-run" key={`${mode}-${shot}`} data-mode={mode}>
					{wires(
						<>
							{wire({
								key: 'top',
								d: `M${chatEdge} ${heroTop} L${cardEdge} ${heroTop}`,
								on: !recall,
							})}
							{wire({
								key: 'bottom',
								d: `M${cardEdge} ${heroBottom} L${chatEdge} ${heroBottom}`,
								on: recall,
							})}
						</>,
						heroHeight,
					)}
					<div class="pw-node pw-mem-chat" style={at(3, 50)}>
						<div class="pw-mem-chat-head">
							{icon(recall ? 'cursor' : 'claude')}
							<strong id="memory-agent">
								{recall ? 'Your next connected agent' : 'Your first agent'}
							</strong>
						</div>
						<p class="pw-mem-bubble pw-mem-ask" id="memory-text">
							{recall
								? 'Help me write a project update using my saved preference.'
								: 'Remember this for my project updates.'}
						</p>
						<p class="pw-mem-bubble pw-mem-reply" id="memory-result">
							{recall
								? `Relevant memory: ${preference}`
								: 'Saved your writing preference in Kody.'}
						</p>
						{recall ? <p class="pw-mem-draft">{draft}</p> : null}
					</div>
					<div
						class="pw-lane pw-mem-lane"
						style={{
							left: `${chatRight}%`,
							width: `${cardLeft - chatRight}%`,
							top: recall ? '60%' : '40%',
						}}
					>
						<span class="pw-packet">{recall ? 'recall' : 'save'}</span>
					</div>
					<div class="pw-node pw-mem-card" style={at(cardLeft, 50)}>
						<span class="pw-kicker">≡ Kody memory</span>
						<small class="pw-mem-kind">Writing preference</small>
						<blockquote class="pw-mem-quote" id="ms-hero-note">
							{preference}
						</blockquote>
						<span class="pw-mem-foot">
							project updates <span>preference</span>
						</span>
						<span class="pw-mem-stamp" aria-hidden="true">
							{recall ? 'Found' : 'Saved'}
						</span>
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

export type MemoryNoteId = 'writing' | 'projects' | 'people'

export type MemoryNote = {
	id: MemoryNoteId
	kind: string
	fact: string
	task: string
	draft: string
}

const indexHeight = 220
const indexRows: Record<MemoryNoteId, number> = {
	writing: 22,
	projects: 50,
	people: 78,
}

export function MemoryIndexScene(
	handle: Handle<{
		notes: ReadonlyArray<MemoryNote>
		selected: MemoryNoteId
	}>,
) {
	return () => {
		const { notes, selected } = handle.props
		const note = notes.find((entry) => entry.id === selected) ?? notes[0]!
		const rowY = (indexRows[note.id] / 100) * indexHeight
		return (
			<PrimitiveWidgetFrame
				id="memory"
				size="full"
				height={indexHeight}
				class="pw-scene-mem-index"
				stack
			>
				<div class="pw-run" key={note.id}>
					{wires(
						<>
							{wire({
								key: 'search',
								d: `M206 92 C190 92 180 ${rowY} 162 ${rowY}`,
								on: true,
							})}
							{wire({
								key: 'return',
								d: `M162 ${rowY + 6} C184 ${rowY + 6} 190 140 206 140`,
								on: true,
							})}
						</>,
						indexHeight,
					)}
					{notes.map((entry, i) => (
						<div
							key={entry.id}
							class="pw-node pw-mem-row"
							data-on={entry.id === note.id ? '' : undefined}
							style={at(3, indexRows[entry.id], { '--i': String(i) })}
						>
							<small>{entry.kind}</small>
							<span>{entry.fact}</span>
						</div>
					))}
					<span class="pw-mem-query" style={at(50, 7)} aria-hidden="true">
						search memory
					</span>
					<div class="pw-node pw-mem-task" style={at(58, 50)}>
						<span class="pw-kicker">Example draft</span>
						<strong id="ms-task">{note.task}</strong>
						<p id="ms-draft">{note.draft}</p>
						<span class="pw-mem-used">Used: {note.kind.toLowerCase()}</span>
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

export function MemoryEditScene(
	handle: Handle<{
		original: string
		updated: string
		isUpdated: boolean
		shot: number
	}>,
) {
	return () => {
		const { original, updated, isUpdated, shot } = handle.props
		return (
			<PrimitiveWidgetFrame
				id="memory"
				size="full"
				class="pw-scene-mem-edit"
				stack
			>
				<div
					class="pw-run"
					key={`edit-${shot}`}
					data-updated={isUpdated ? '' : undefined}
				>
					{wires(wire({ key: 'steps', d: 'M120 22 L240 22', on: isUpdated }))}
					<span class="pw-mem-step pw-mem-step-find" style={at(4, 11)}>
						1 · Find existing preference
					</span>
					<span class="pw-mem-step pw-mem-step-update" style={at(96, 11)}>
						2 · Update saved entry
					</span>
					<div class="pw-node pw-mem-edit" style={at(50, 58)}>
						<span class="pw-mem-scan" aria-hidden="true"></span>
						<small>Writing preference · local example</small>
						<blockquote
							class="pw-mem-old"
							id={isUpdated ? undefined : 'ms-updated-note'}
						>
							{original}
						</blockquote>
						{isUpdated ? (
							<blockquote class="pw-mem-new" id="ms-updated-note">
								{updated}
							</blockquote>
						) : null}
						<span class="pw-mem-history">
							{isUpdated
								? 'Edited just now · 1 earlier version'
								: 'Saved 3 weeks ago · used in 12 drafts'}
						</span>
						<span class="pw-mem-badge" aria-hidden="true">
							{isUpdated ? 'Updated' : 'Saved'}
						</span>
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}
