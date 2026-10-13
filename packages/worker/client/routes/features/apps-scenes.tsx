import { type Handle, on, type RemixNode } from 'remix/component'
import { icon, PrimitiveWidgetFrame } from '#client/primitive-widget-parts.tsx'
import { type Brief } from './apps-intake.tsx'

/**
 * `/features/apps` scenes. The page's own controls drive them. A keyed
 * `.pw-run` replays a story on each click. The intake fields stay outside
 * those runs so typing never restarts an animation.
 */

const returnHeight = 214
const shareHeight = 204

export const tomorrowBrief = {
	name: 'Launch checklist',
	kind: 'Campaign',
	deadline: 'November 4',
} as const

function appChrome(badge: string) {
	return (
		<div class="pw-apx-chrome">
			<span class="pw-apx-dots" aria-hidden="true"></span>
			<span class="pw-apx-url">kody.app/project-intake</span>
			<span class="pw-apx-demo">{badge}</span>
		</div>
	)
}

export function AppsHeroScene(
	handle: Handle<{
		promptShot: number
		saveShot: number
		count: number
		flyingName: string
		formPressed: boolean
		recordsPressed: boolean
		onShowForm: () => void
		onShowRecords: () => void
		children?: RemixNode
	}>,
) {
	return () => {
		const {
			promptShot,
			saveShot,
			count,
			flyingName,
			formPressed,
			recordsPressed,
			children,
		} = handle.props
		return (
			<PrimitiveWidgetFrame id="apps" size="full" class="pw-scene-apx-hero">
				<div class="pw-apx-shell">
					<div class="pw-run pw-apx-prompt-run" key={`prompt-${promptShot}`}>
						<div class="pw-apx-prompt-row">
							<div class="pw-apx-prompt">
								<span class="pw-apx-prompt-head">
									{icon('cursor')}
									Your agent
								</span>
								<p class="pw-apx-prompt-text">Make me a project intake form</p>
							</div>
							<span class="pw-apx-hosted">Hosted</span>
						</div>
					</div>
					<div class="pw-apx-lane" aria-hidden="true">
						<span class="pw-apx-packet">build</span>
					</div>
					<div class="pw-apx-window">
						{appChrome('Demo app')}
						<div id="intake-demo">
							<div class="pw-apx-tabs" aria-label="Demo views">
								<button
									type="button"
									class="pw-apx-tab"
									aria-pressed={formPressed}
									mix={on('click', () => {
										handle.props.onShowForm()
									})}
								>
									Intake form
								</button>
								<button
									type="button"
									class="pw-apx-tab"
									aria-pressed={recordsPressed}
									mix={on('click', () => {
										handle.props.onShowRecords()
									})}
								>
									Saved briefs
									<span class="pw-apx-badge-wrap">
										<span
											class="pw-apx-badge"
											key={saveShot}
											data-pop={saveShot > 0 ? '' : undefined}
										>
											{count}
										</span>
										{saveShot > 0 ? (
											<span
												class="pw-apx-fly"
												key={`fly-${saveShot}`}
												aria-hidden="true"
											>
												<strong>{flyingName}</strong>
												<small>Saved</small>
											</span>
										) : null}
									</span>
								</button>
							</div>
							<div class="pw-apx-body">{children}</div>
						</div>
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

function keptMark() {
	return (
		<svg class="pw-apx-check" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M3 8.5 6.5 12 13 4" />
		</svg>
	)
}

function dayCard(brief: Brief, opened: boolean) {
	return (
		<div class="pw-apx-card" data-on={opened ? '' : undefined}>
			<span class="pw-apx-card-top">
				<strong>{brief.name}</strong>
			</span>
			<small>
				{brief.kind} · {brief.deadline}
			</small>
		</div>
	)
}

export function AppsReturnScene(
	handle: Handle<{
		records: ReadonlyArray<Brief>
		openedId?: number
	}>,
) {
	return () => {
		const { records, openedId } = handle.props
		const shown = records.slice(0, 2)
		const extra = records.length - shown.length
		const signature = records
			.map((record) => `${record.id}:${record.name}`)
			.join('|')
		return (
			<PrimitiveWidgetFrame
				id="apps"
				size="full"
				height={returnHeight}
				class="pw-scene-apx-return"
			>
				<div class="pw-run" key={`${signature}-${openedId ?? 'none'}`}>
					<div class="pw-apx-window pw-apx-window-fill">
						{appChrome('Saved briefs')}
						<div class="pw-apx-cal">
							<div class="pw-apx-col">
								<span class="pw-apx-dayhead">Today</span>
								{shown.map((brief) => (
									<div key={`today-${brief.id}`}>
										{dayCard(brief, brief.id === openedId)}
									</div>
								))}
								{extra > 0 ? (
									<small class="pw-apx-more">+{extra} more</small>
								) : null}
							</div>
							<div class="pw-apx-col pw-apx-col-next">
								<span class="pw-apx-dayhead">
									Tomorrow
									<span class="pw-apx-cursor" aria-hidden="true"></span>
								</span>
								{shown.map((brief, index) => (
									<div
										class="pw-apx-card"
										key={`next-${brief.id}`}
										data-on={brief.id === openedId ? '' : undefined}
									>
										<span class="pw-apx-card-top">
											<strong>{brief.name}</strong>
											{index === 0 ? (
												<span class="pw-apx-kept" aria-hidden="true"></span>
											) : null}
											{keptMark()}
										</span>
										<small>
											{brief.kind} · {brief.deadline}
										</small>
									</div>
								))}
								<div class="pw-apx-card pw-apx-card-new">
									<span class="pw-apx-card-top">
										<strong>{tomorrowBrief.name}</strong>
										<span class="pw-apx-newtag">New</span>
									</span>
									<small>
										{tomorrowBrief.kind} · {tomorrowBrief.deadline}
									</small>
								</div>
								{extra > 0 ? (
									<small class="pw-apx-more">+{extra} more</small>
								) : null}
							</div>
						</div>
						<p class="pw-apx-foot">Saved with the package</p>
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}

export type AccessRole = 'Use' | 'Contribute' | 'Manage'

function fillFor(role: AccessRole) {
	switch (role) {
		case 'Use':
			return '0.08'
		case 'Contribute':
			return '0.5'
		case 'Manage':
			return '1'
		default: {
			const unknown: never = role
			throw new Error(`Unknown access: ${String(unknown)}`)
		}
	}
}

function morganSheet(role: AccessRole, brief: Brief) {
	switch (role) {
		case 'Use':
			return (
				<div class="pw-apx-sheet">
					<span class="pw-kicker">Read only</span>
					<strong class="pw-apx-sheet-title">{brief.name}</strong>
					<p>
						{brief.kind} · {brief.deadline}
					</p>
					<p class="pw-apx-copy">{brief.copy}</p>
					<span class="pw-apx-action">
						Run
						<span class="pw-apx-cursor" aria-hidden="true"></span>
					</span>
					<span class="pw-apx-toast">Ran project-intake</span>
				</div>
			)
		case 'Contribute':
			return (
				<div class="pw-apx-sheet">
					<span class="pw-kicker">Can edit</span>
					<span class="pw-apx-field">
						<span>Project</span>
						<span class="pw-apx-value">{brief.name}</span>
					</span>
					<span class="pw-apx-field">
						<span>Job</span>
						<span class="pw-apx-value">{brief.kind}</span>
					</span>
					<span class="pw-apx-action">
						Edit
						<span class="pw-apx-cursor" aria-hidden="true"></span>
					</span>
					<span class="pw-apx-toast">Editing the package</span>
				</div>
			)
		case 'Manage':
			return (
				<div class="pw-apx-sheet">
					<span class="pw-kicker">Manage</span>
					<span class="pw-apx-field">
						<span>Project</span>
						<span class="pw-apx-value">{brief.name}</span>
					</span>
					<span class="pw-apx-actions">
						<span class="pw-apx-action pw-apx-action-quiet">Edit</span>
						<span class="pw-apx-action">
							Publish
							<span class="pw-apx-cursor" aria-hidden="true"></span>
						</span>
					</span>
					<p class="pw-apx-access">Access · Morgan · Manage</p>
					<span class="pw-apx-toast">Published · access updated</span>
				</div>
			)
		default: {
			const unknown: never = role
			throw new Error(`Unknown access: ${String(unknown)}`)
		}
	}
}

export function AppsShareScene(
	handle: Handle<{
		role: AccessRole
		brief: Brief
		shot: number
	}>,
) {
	return () => {
		const { role, brief, shot } = handle.props
		return (
			<PrimitiveWidgetFrame
				id="apps"
				size="full"
				height={shareHeight}
				class="pw-scene-apx-share"
			>
				<div
					class="pw-run"
					key={`${role}-${shot}-${brief.name}`}
					data-role={role}
				>
					<div class="pw-apx-track">
						<span class="pw-apx-track-line" aria-hidden="true"></span>
						<span
							class="pw-apx-track-fill"
							aria-hidden="true"
							style={{ '--pw-apx-fill': fillFor(role) }}
						></span>
						<span class="pw-apx-step" data-on="">
							<span class="pw-apx-dot" aria-hidden="true"></span>
							Read + run
						</span>
						<span class="pw-apx-step" data-on={role === 'Use' ? undefined : ''}>
							<span class="pw-apx-dot" aria-hidden="true"></span>
							Edit
						</span>
						<span
							class="pw-apx-step"
							data-on={role === 'Manage' ? '' : undefined}
						>
							<span class="pw-apx-dot" aria-hidden="true"></span>
							Publish + access
						</span>
					</div>
					<div class="pw-apx-window pw-apx-window-fill">
						{appChrome('Morgan')}
						<p class="pw-apx-view-label">Morgan’s view</p>
						{morganSheet(role, brief)}
					</div>
				</div>
			</PrimitiveWidgetFrame>
		)
	}
}
