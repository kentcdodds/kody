import { type Handle } from 'remix/component'
import {
	at,
	PrimitiveWidgetFrame,
	wire,
	wires,
} from '#client/primitive-widget-parts.tsx'

/**
 * `/features/packages` scenes. The page's own controls drive them; each
 * scene holds the visible example text, and `public/feature-scenes/packages.css`
 * animates it. A keyed `.pw-run` restarts the timeline on each click. The
 * still (no `data-motion`) is the finished end state.
 */

export type PackageTab = 'intent' | 'source' | 'result'
export type PackageAccess = 'use' | 'contribute' | 'manage'
export type PackageSharing = 'share' | 'fork'

const heroHeight = 232
const publishHeight = 348
const shareHeight = 300

const packageFiles = [
	'README.md',
	'AGENTS.md',
	'package.json',
	'src/brief.ts',
] as const

const briefSource = [
	'export function brief(week) {',
	"  title: 'Weekly brief',",
	'  orchard: week.orchard,',
	'  fieldwork: week.fieldwork,',
	'}',
] as const

const accessChips = [
	{ id: 'read', label: 'Read' },
	{ id: 'run', label: 'Run' },
	{ id: 'edit', label: 'Edit' },
	{ id: 'publish', label: 'Publish' },
	{ id: 'access', label: 'Access' },
] as const

type AccessChip = (typeof accessChips)[number]['id']

function chipLit(access: PackageAccess, chip: AccessChip) {
	switch (access) {
		case 'use':
			return chip === 'read' || chip === 'run'
		case 'contribute':
			return chip === 'read' || chip === 'run' || chip === 'edit'
		case 'manage':
			return true
		default: {
			const exhaustive: never = access
			return exhaustive
		}
	}
}

function accessLabel(access: PackageAccess) {
	switch (access) {
		case 'use':
			return 'Use'
		case 'contribute':
			return 'Contribute'
		case 'manage':
			return 'Manage'
		default: {
			const exhaustive: never = access
			return exhaustive
		}
	}
}

function renderBrief(question: boolean) {
	return (
		<>
			<h3>Weekly brief</h3>
			<p>
				Orchard: design review is ready.
				<br />
				Fieldwork: kickoff is booked.
			</p>
			{question ? (
				<p class="pw-pkg-question">
					Open question: Who approves the final copy?
				</p>
			) : null}
		</>
	)
}

export function PackageWorkbenchScene(
	handle: Handle<{ tab: PackageTab; live: boolean; shot: number }>,
) {
	return () => {
		const { tab, live, shot } = handle.props
		return (
			<PrimitiveWidgetFrame
				id="packages"
				size="full"
				height={heroHeight}
				class="pw-scene-pkg-hero"
			>
				<div
					class="pw-run"
					key={`${tab}-${shot}-${live ? 'live' : 'base'}`}
					data-mode={tab}
					data-live={live ? '' : undefined}
				>
					{heroBody(tab, live)}
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

function heroBody(tab: PackageTab, live: boolean) {
	switch (tab) {
		case 'intent':
			return (
				<>
					{wires(
						wire({ key: 'into', d: 'M168 116 L220 116', on: true }),
						heroHeight,
					)}
					<div
						class="pw-node pw-pkg-card pw-pkg-side pw-pkg-chat"
						style={at(2, 50)}
					>
						<span class="pw-kicker">Your agent</span>
						<p class="pw-pkg-ask">
							Collect the project updates I choose and turn them into a weekly
							brief.
						</p>
					</div>
					<div
						class="pw-node pw-pkg-card pw-pkg-side pw-pkg-born"
						style={at(62, 50)}
					>
						<span class="pw-pkg-card-head">
							<span class="pw-kicker pw-pkg-name">◇ weekly-brief</span>
							<span class="pw-pkg-badge">Published</span>
						</span>
						<ul class="pw-pkg-files">
							{packageFiles.map((file, index) => (
								<li key={file} style={{ '--i': String(index) }}>
									{file}
								</li>
							))}
						</ul>
					</div>
				</>
			)
		case 'source':
			return (
				<>
					{wires(
						wire({ key: 'open', d: 'M154 128 L206 128', on: true }),
						heroHeight,
					)}
					<div
						class="pw-node pw-pkg-card pw-pkg-side pw-pkg-tree"
						style={at(2, 50)}
					>
						<span class="pw-kicker">weekly-brief</span>
						<ul class="pw-pkg-files">
							{packageFiles.map((file) => (
								<li
									key={file}
									data-on={file === 'src/brief.ts' ? '' : undefined}
								>
									{file}
								</li>
							))}
						</ul>
					</div>
					<div
						class="pw-node pw-pkg-card pw-pkg-side pw-pkg-editor"
						style={at(58, 50)}
					>
						<span class="pw-kicker">src/brief.ts</span>
						<code class="pw-pkg-code">
							{briefSource.map((line, index) => (
								<span
									key={line}
									class="pw-pkg-line"
									style={{ '--i': String(index) }}
								>
									{line}
								</span>
							))}
						</code>
					</div>
				</>
			)
		case 'result':
			return (
				<>
					{wires(
						wire({ key: 'run', d: 'M154 116 L206 116', on: true }),
						heroHeight,
					)}
					<div
						class="pw-node pw-pkg-card pw-pkg-side pw-pkg-log"
						style={at(2, 50)}
					>
						<span class="pw-kicker">Run</span>
						<ol class="pw-pkg-loglines">
							<li style={{ '--i': '0' }}>› run weekly-brief</li>
							<li style={{ '--i': '1' }}>read src/brief.ts</li>
							<li style={{ '--i': '2' }}>wrote Weekly brief</li>
						</ol>
					</div>
					<div
						class="pw-node pw-pkg-card pw-pkg-side pw-pkg-result"
						style={at(58, 50)}
					>
						<span class="pw-kicker">Result</span>
						<div class="pw-pkg-brief">{renderBrief(live)}</div>
					</div>
				</>
			)
		default: {
			const exhaustive: never = tab
			return exhaustive
		}
	}
}

export function PackagePublishScene(
	handle: Handle<{
		questions: boolean
		previewed: boolean
		previewQuestions: boolean
		live: boolean
		version: number
		shot: number
	}>,
) {
	return () => {
		const { questions, previewed, previewQuestions, live, version, shot } =
			handle.props
		const proposedDiffers = previewed && previewQuestions !== live
		return (
			<PrimitiveWidgetFrame
				id="packages"
				size="full"
				height={publishHeight}
				class="pw-scene-pkg-publish"
			>
				<div
					class="pw-run pw-pkg-board"
					key={`${shot}-${version}-${previewed ? 'pre' : 'src'}-${questions ? 'q' : 'base'}`}
					data-acted={shot > 0 ? '' : undefined}
					data-preview={previewed ? '' : undefined}
					data-published={version > 1 ? '' : undefined}
					data-questions={questions ? '' : undefined}
				>
					<article class="pw-node pw-pkg-card pw-pkg-diff">
						<span class="pw-pkg-card-head">
							<span class="pw-kicker">Repo source · src/brief.ts</span>
						</span>
						<code class="pw-pkg-code">
							<span class="pw-pkg-line">export function brief(week) {'{'}</span>
							<span class="pw-pkg-line"> return format(week)</span>
							{questions ? (
								<span class="pw-pkg-line pw-pkg-add">
									+ openQuestion: 'Who approves the final copy?'
								</span>
							) : null}
							<span class="pw-pkg-line">{'}'}</span>
						</code>
					</article>
					<div class="pw-pkg-bridge" aria-hidden="true">
						<span class="pw-pkg-packet">preview</span>
					</div>
					<div class="pw-pkg-compare">
						{previewed ? (
							<article
								class="pw-node pw-pkg-card pw-pkg-out"
								data-diff={proposedDiffers ? '' : undefined}
							>
								<small>Proposed output</small>
								<div class="pw-pkg-brief">{renderBrief(previewQuestions)}</div>
							</article>
						) : (
							<article class="pw-node pw-pkg-card pw-pkg-out pw-pkg-wait">
								<small>Proposed output</small>
								<p>Preview the proposed change.</p>
							</article>
						)}
						<article class="pw-node pw-pkg-card pw-pkg-out pw-pkg-current">
							<small>Current published output</small>
							<div class="pw-pkg-brief">{renderBrief(live)}</div>
						</article>
					</div>
					<div class="pw-pkg-publish-step">
						<span class="pw-pkg-step-label">Publish</span>
						<div class="pw-pkg-bridge pw-pkg-bridge-pub" aria-hidden="true">
							<span class="pw-pkg-packet">runs</span>
						</div>
					</div>
					<article class="pw-node pw-pkg-card pw-pkg-runs">
						<span class="pw-pkg-card-head">
							<span class="pw-kicker">Runs here · weekly-brief</span>
							<span class="pw-pkg-badge" key={`v-${version}`}>
								v{version}
							</span>
						</span>
						<div class="pw-pkg-brief">{renderBrief(live)}</div>
					</article>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

export function PackageShareScene(
	handle: Handle<{
		sharing: PackageSharing
		access: PackageAccess
		copyEdited: boolean
		shot: number
	}>,
) {
	return () => {
		const { sharing, access, copyEdited, shot } = handle.props
		return (
			<PrimitiveWidgetFrame
				id="packages"
				size="full"
				height={shareHeight}
				class="pw-scene-pkg-share"
			>
				<div
					class="pw-run"
					key={`${sharing}-${access}-${copyEdited ? 'edit' : 'same'}-${shot}`}
					data-mode={sharing}
					data-access={access}
					data-edited={copyEdited ? '' : undefined}
				>
					{renderSharing(sharing, access, copyEdited)}
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

function renderSharing(
	sharing: PackageSharing,
	access: PackageAccess,
	copyEdited: boolean,
) {
	switch (sharing) {
		case 'share':
			return renderShareDiagram(access)
		case 'fork':
			return renderForkDiagram(copyEdited)
		default: {
			const exhaustive: never = sharing
			return exhaustive
		}
	}
}

function renderShareDiagram(access: PackageAccess) {
	return (
		<>
			{wires(
				<>
					{wire({
						key: 'you',
						d: 'M180 102 C180 128 86 148 86 174',
						on: true,
					})}
					{wire({
						key: 'mate',
						d: 'M180 102 C180 128 274 148 274 174',
						on: true,
						i: 1,
					})}
				</>,
				shareHeight,
			)}
			<div class="pw-node pw-pkg-card pw-pkg-package" style={at(50, 34)}>
				<span class="pw-kicker">◇ weekly-brief</span>
				<strong>One live package</strong>
				<span class="pw-pkg-meta">Shared · runs in your organization</span>
			</div>
			<div class="pw-node pw-pkg-card pw-pkg-person" style={at(24, 58)}>
				<span class="pw-pkg-who">
					<span class="pw-pkg-avatar" aria-hidden="true">
						Y
					</span>
					You
				</span>
				<span class="pw-pkg-meta">Owner</span>
			</div>
			<div
				class="pw-node pw-pkg-card pw-pkg-person pw-pkg-mate"
				style={at(76, 58)}
			>
				<span class="pw-pkg-who">
					<span class="pw-pkg-avatar" aria-hidden="true">
						T
					</span>
					Teammate
				</span>
				<span class="pw-pkg-meta">{accessLabel(access)}</span>
				<ul class="pw-pkg-chips">
					{accessChips.map((chip, index) => (
						<li
							key={chip.id}
							class="pw-pkg-chip"
							data-on={chipLit(access, chip.id) ? '' : undefined}
							style={{ '--i': String(index) }}
						>
							{chip.label}
						</li>
					))}
				</ul>
			</div>
		</>
	)
}

function renderForkDiagram(copyEdited: boolean) {
	return (
		<>
			{wires(
				<>
					{wire({
						key: 'keep',
						d: 'M180 48 C180 84 86 112 86 136',
						on: true,
					})}
					{wire({
						key: 'copy',
						d: 'M180 48 C180 84 274 112 274 136',
						on: true,
						i: 1,
					})}
				</>,
				shareHeight,
			)}
			<span class="pw-pkg-origin" style={at(50, 10)}>
				◇ weekly-brief · public
			</span>
			<div class="pw-node pw-pkg-card pw-pkg-copy" style={at(24, 52)}>
				<span class="pw-pkg-who">
					<span class="pw-pkg-avatar" aria-hidden="true">
						Y
					</span>
					You
				</span>
				<strong>Weekly brief</strong>
				<span class="pw-pkg-meta">Owner · project updates</span>
			</div>
			<div
				class="pw-node pw-pkg-card pw-pkg-copy pw-pkg-fork-copy"
				style={at(76, 52)}
				data-edited={copyEdited ? '' : undefined}
			>
				<span class="pw-pkg-who">
					<span class="pw-pkg-avatar" aria-hidden="true">
						T
					</span>
					Teammate
				</span>
				<strong class="pw-pkg-copy-title">
					{copyEdited ? 'Customer brief' : 'Weekly brief'}
				</strong>
				<span class="pw-pkg-meta">
					{copyEdited ? 'Owner · customer updates' : 'Owner · project updates'}
				</span>
			</div>
		</>
	)
}
