import { css, type Handle } from 'remix/component'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	describeFollowEvents,
	describePausedFollow,
	followDeliveryNote,
	followPostErrorMessage,
	followEventOptions,
	initialFollowEventChoice,
	postOrgFollow,
} from '#client/routes/follows-shared.ts'
import {
	followSkipReasonCopy,
	isFollowTargetKindName,
	normalizeFollowEvents,
	type FollowEvent,
	type FollowTargetKindName,
	type PackageFollowStatePayload,
} from '#universal/follows.ts'
import { renderIcon } from '#universal/icon.tsx'
import { orgResourcePath } from '#universal/org-pages.ts'
import {
	PACKAGE_FOLLOW_HASH,
	PACKAGE_FOLLOW_PANEL_ID,
} from '#universal/package-title-actions.tsx'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

type PackageRef = { pathname: string; username: string; kodyId: string }

type LoadState = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'

const followControlSelector = '[data-package-follow]'

/**
 * The Follow control in the repository action group opens this panel on the
 * Repo tab (other tabs link to `#follow`). The panel loads which of the
 * viewer's workspaces follow the target, lets them pick events, and posts to
 * the chosen workspace's `/@slug/-/follows.json`, so the following org is
 * always the one named in the URL.
 */
export function createPackageFollowController(
	handle: Handle,
	options: {
		getPackageRef(): PackageRef | null
		/** A follow changed; the action group should repaint its label. */
		onChanged(): Promise<void> | void
	},
) {
	let open = false
	let loadState: LoadState = 'idle'
	let loadedFor: string | null = null
	let loadRequestId = 0
	let state: PackageFollowStatePayload | null = null
	let kind: FollowTargetKindName | null = null
	let selectedSlug: string | null = null
	let chosenEvents: Array<FollowEvent> = []
	let submitting = false
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let autoOpenedFor: string | null = null
	const unfollowCheck = createDoubleCheck(handle)

	function selectedWorkspace() {
		if (!state) return null
		return (
			state.workspaces.find((workspace) => workspace.slug === selectedSlug) ??
			state.workspaces[0] ??
			null
		)
	}

	function selectWorkspace(slug: string | null) {
		selectedSlug = slug
		const workspace = selectedWorkspace()
		chosenEvents = state
			? initialFollowEventChoice(state, workspace?.follow ?? null)
			: []
	}

	function syncControl() {
		if (typeof document === 'undefined') return
		for (const control of document.querySelectorAll(followControlSelector)) {
			control.setAttribute('aria-expanded', open ? 'true' : 'false')
		}
	}

	async function load(ref: PackageRef) {
		const requestId = ++loadRequestId
		loadState = 'loading'
		message = null
		handle.update()
		try {
			const response = await fetch(
				routes.communityPackageFollowApi.href(
					{ username: ref.username, kodyId: ref.kodyId },
					kind ? { searchParams: { kind } } : undefined,
				),
				{ headers: { Accept: 'application/json' }, credentials: 'include' },
			)
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign(
					routes.login.href(null, {
						searchParams: {
							redirectTo: `${ref.pathname}${PACKAGE_FOLLOW_HASH}`,
						},
					}),
				)
				return
			}
			if (response.status === 404) {
				loadedFor = ref.pathname
				loadState = 'unavailable'
				state = null
				handle.update()
				return
			}
			const payload = await readJson<PackageFollowStatePayload>(response)
			if (requestId !== loadRequestId) return
			if (!response.ok || !payload?.ok) throw new Error('load failed')
			state = payload
			kind = payload.target.kind
			loadedFor = ref.pathname
			loadState = 'ready'
			const keep = payload.workspaces.some(
				(workspace) => workspace.slug === selectedSlug,
			)
			selectWorkspace(
				keep
					? selectedSlug
					: (payload.workspaces.find((workspace) => workspace.follow)?.slug ??
							payload.workspaces[0]?.slug ??
							null),
			)
			handle.update()
		} catch {
			if (requestId !== loadRequestId) return
			loadedFor = ref.pathname
			loadState = 'error'
			handle.update()
		}
	}

	function setOpen(next: boolean) {
		open = next
		syncControl()
		const ref = options.getPackageRef()
		if (open && ref && loadState === 'error') void load(ref)
		handle.update()
		if (open) {
			handle.queueTask(() => {
				document.getElementById(PACKAGE_FOLLOW_PANEL_ID)?.focus()
			})
		}
	}

	async function submit(intent: 'follow' | 'unfollow') {
		const workspace = selectedWorkspace()
		if (!state || !workspace || submitting) return
		submitting = true
		message = null
		handle.update()
		const target = state.target
		const payload = await postOrgFollow(
			workspace.slug,
			intent === 'follow'
				? {
						intent: 'follow',
						name: target.name,
						kind: target.kind,
						events: normalizeFollowEvents(chosenEvents),
					}
				: { intent: 'unfollow', name: target.name, kind: target.kind },
		).catch(() => null)
		submitting = false
		if (!payload) {
			message = 'Unable to update this follow. Try again.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (!payload.ok) {
			if (payload.code === 'unauthorized') {
				window.location.assign(routes.login.href())
				return
			}
			message = followPostErrorMessage(payload)
			messageTone = 'error'
			handle.update()
			return
		}
		const wasFollowing = workspace.follow !== null
		workspace.follow = payload.follow
		chosenEvents = initialFollowEventChoice(state, payload.follow)
		messageTone = 'info'
		message =
			intent === 'unfollow'
				? `Unfollowed in ${workspaceLabel(workspace)}.`
				: payload.follow?.status === 'paused'
					? (describePausedFollow(payload.follow) ?? 'This follow is paused.')
					: wasFollowing
						? `Saved. ${describeFollowEvents(payload.follow?.events ?? [])} go to ${workspaceLabel(workspace)}.`
						: `Following. ${describeFollowEvents(payload.follow?.events ?? [])} go to ${workspaceLabel(workspace)}.`
		if (payload.follow?.status === 'paused') messageTone = 'error'
		handle.update()
		await options.onChanged()
		syncControl()
	}

	function handleClick(event: Event) {
		const target = event.target
		if (!(target instanceof Element)) return
		const control = target.closest(followControlSelector)
		if (!control) return
		event.preventDefault()
		const controlKind = control.getAttribute('data-package-follow')
		if (isFollowTargetKindName(controlKind)) kind = controlKind
		setOpen(!open)
	}

	return {
		mixins: [on('click', handleClick)],

		/** The page changed: close and forget the previous target. */
		navigated(pathname: string | null) {
			if (pathname !== autoOpenedFor) autoOpenedFor = null
			if (pathname !== null && pathname === loadedFor) return
			open = false
			loadRequestId++
			loadState = 'idle'
			loadedFor = null
			state = null
			kind = null
			selectedSlug = null
			message = null
			unfollowCheck.reset()
		},

		/** Opens the panel once per visit when the URL asks for it (`#follow`). */
		maybeAutoOpen(pathname: string) {
			if (typeof window === 'undefined') return
			if (window.location.hash !== PACKAGE_FOLLOW_HASH) {
				autoOpenedFor = null
				return
			}
			if (autoOpenedFor === pathname) return
			autoOpenedFor = pathname
			handle.queueTask(() => setOpen(true))
		},

		syncControl,

		render() {
			if (!open) return null
			const ref = options.getPackageRef()
			if (
				ref &&
				loadState !== 'loading' &&
				loadState !== 'error' &&
				loadedFor !== ref.pathname
			) {
				loadState = 'loading'
				handle.queueTask(() => load(ref))
			}
			const workspace = selectedWorkspace()
			return (
				<section
					id={PACKAGE_FOLLOW_PANEL_ID}
					tabIndex={-1}
					aria-labelledby="package-follow-title"
					data-testid="package-follow-panel"
					mix={css(panelCss)}
				>
					<div mix={css(panelHeadCss)}>
						<h2 id="package-follow-title" mix={css(panelTitleCss)}>
							{state ? `Follow ${state.target.name}` : 'Follow'}
						</h2>
						<button
							type="button"
							aria-label="Close follow options"
							data-testid="package-follow-close"
							mix={[
								css(getGhostButtonCss({ size: 'sm' })),
								on('click', () => setOpen(false)),
							]}
						>
							{renderIcon('close', { size: '1.05rem' })}
						</button>
					</div>
					{loadState === 'loading' && !state ? (
						<p role="status" mix={css(mutedCss)}>
							Loading follow options…
						</p>
					) : null}
					{loadState === 'error' ? (
						<p role="alert" mix={css(errorCss)}>
							Unable to load follow options. Close and try again.
						</p>
					) : null}
					{loadState === 'unavailable' ? (
						<p role="alert" mix={css(errorCss)}>
							You can’t follow this. You need access to it first.
						</p>
					) : null}
					{state && workspace ? renderPanelBody({ state, workspace }) : null}
					{state && !workspace ? (
						<p mix={css(mutedCss)}>
							You need to be a member of a workspace to follow this.
						</p>
					) : null}
				</section>
			)
		},
	}

	function renderPanelBody(input: {
		state: PackageFollowStatePayload
		workspace: PackageFollowStatePayload['workspaces'][number]
	}) {
		const { state: current, workspace } = input
		const follow = workspace.follow
		const eventOptions = followEventOptions(current)
		const offerable = eventOptions.filter((option) => !option.disabledReason)
		const blocked = offerable.length === 0
		const paused = follow ? describePausedFollow(follow) : null
		const skipped = follow
			? followSkipReasonCopy(follow.lastDeliverySkipReason)
			: null
		const nothingChosen = chosenEvents.length === 0
		const unchanged =
			follow?.status === 'active' &&
			normalizeFollowEvents(follow.events).join() ===
				normalizeFollowEvents(chosenEvents).join()
		const primaryLabel = !follow
			? 'Follow'
			: follow.status === 'paused'
				? 'Resume'
				: 'Save'
		return (
			<>
				{current.workspaces.length > 1 ? (
					<label mix={css(fieldCss)}>
						<span mix={css(labelCss)}>Follow in</span>
						<select
							data-testid="package-follow-workspace"
							mix={[
								css(getSelectCss()),
								on('change', (event) => {
									const value = (event.currentTarget as HTMLSelectElement).value
									selectWorkspace(value)
									message = null
									unfollowCheck.reset()
									handle.update()
								}),
							]}
						>
							{current.workspaces.map((option) => (
								<option
									key={option.slug}
									value={option.slug}
									selected={option.slug === workspace.slug}
								>
									{workspaceOptionLabel(option)}
									{option.follow ? ' (following)' : ''}
								</option>
							))}
						</select>
					</label>
				) : (
					<p mix={css(mutedCss)}>Events go to {workspaceLabel(workspace)}.</p>
				)}
				<p data-testid="package-follow-status" mix={css(statusCss)}>
					{follow
						? follow.status === 'paused'
							? paused
							: `Following. ${describeFollowEvents(follow.events)} go to this workspace.`
						: 'Not following in this workspace.'}
				</p>
				{skipped ? <p mix={css(statusCss)}>{skipped}</p> : null}
				<fieldset mix={css(fieldsetCss)}>
					<legend mix={css(labelCss)}>Send events for</legend>
					{eventOptions.map((option) => {
						const disabled = Boolean(option.disabledReason)
						return (
							<label
								key={option.event}
								data-testid={`package-follow-event-${option.event}`}
								mix={css(optionCss)}
							>
								<input
									type="checkbox"
									name="events"
									value={option.event}
									checked={!disabled && chosenEvents.includes(option.event)}
									disabled={disabled || submitting}
									mix={on('change', (event) => {
										const checked = (event.currentTarget as HTMLInputElement)
											.checked
										chosenEvents = checked
											? normalizeFollowEvents([...chosenEvents, option.event])
											: chosenEvents.filter((item) => item !== option.event)
										handle.update()
									})}
								/>
								<span mix={css(optionTextCss)}>
									<span mix={css(optionLabelCss)}>{option.label}</span>
									<span mix={css(mutedSmallCss)}>{option.description}</span>
									{option.disabledReason ? (
										<span
											data-testid={`package-follow-event-${option.event}-gated`}
											mix={css(gatedCss)}
										>
											{option.disabledReason}
										</span>
									) : null}
								</span>
							</label>
						)
					})}
				</fieldset>
				{blocked && !follow ? (
					<p data-testid="package-follow-blocked" mix={css(statusCss)}>
						{current.target.kind === 'repo'
							? 'Repositories only send pushes, so you can’t follow this one until you have read access.'
							: 'There is nothing you can follow here yet.'}
					</p>
				) : null}
				<div mix={css(actionsCss)}>
					<button
						type="button"
						data-testid="package-follow-submit"
						disabled={
							submitting || blocked || nothingChosen || Boolean(unchanged)
						}
						mix={[
							css(getPillButtonCss({ size: 'sm' })),
							on('click', () => void submit('follow')),
						]}
					>
						{renderIcon(follow ? 'check' : 'eye', { size: '1.05rem' })}
						{submitting ? 'Saving…' : primaryLabel}
					</button>
					{follow ? (
						<button
							type="button"
							data-testid="package-follow-unfollow"
							disabled={submitting}
							mix={[
								css(getDangerPillCss({ size: 'sm' })),
								...unfollowCheck.getButtonMix({
									on: { click: () => void submit('unfollow') },
								}),
							]}
						>
							{renderIcon('close', { size: '1.05rem' })}
							{unfollowCheck.doubleCheck ? 'Confirm unfollow' : 'Unfollow'}
						</button>
					) : null}
				</div>
				{nothingChosen && !blocked ? (
					<p mix={css(mutedSmallCss)}>
						Choose at least one. To stop everything, unfollow.
					</p>
				) : null}
				{message ? (
					<p
						data-testid="package-follow-message"
						role={messageTone === 'error' ? 'alert' : 'status'}
						mix={css(messageTone === 'error' ? errorCss : statusCss)}
					>
						{message}
					</p>
				) : null}
				<p mix={css(mutedSmallCss)}>
					{followDeliveryNote}{' '}
					<a
						href={orgResourcePath(workspace.slug, 'follows')}
						data-testid="package-follow-manage"
					>
						Manage follows
					</a>
				</p>
			</>
		)
	}
}

type WorkspaceName = {
	slug: string
	displayName: string | null
	personal: boolean
}

function workspaceLabel(workspace: WorkspaceName) {
	if (workspace.personal) return 'your personal workspace'
	return workspace.displayName?.trim() || workspace.slug
}

function workspaceOptionLabel(workspace: WorkspaceName) {
	if (workspace.personal) return 'Personal workspace'
	return workspaceLabel(workspace)
}

const panelCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	marginBlock: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	'&:focus': { outline: 'none' },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const panelHeadCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.md,
}

const panelTitleCss = {
	margin: 0,
	fontSize: '1.05rem',
	fontWeight: 700,
	letterSpacing: '-0.01em',
	overflowWrap: 'anywhere' as const,
}

const mutedCss = { margin: 0, color: colors.textMuted, lineHeight: 1.5 }

const mutedSmallCss = {
	...mutedCss,
	fontSize: typography.fontSize.sm,
}

const statusCss = { margin: 0, color: colors.text, lineHeight: 1.5 }

const errorCss = { margin: 0, color: colors.error, lineHeight: 1.5 }

const gatedCss = {
	fontSize: typography.fontSize.sm,
	color: colors.warningText,
	lineHeight: 1.45,
}

const fieldCss = { display: 'grid', gap: spacing.xs, maxWidth: '24rem' }

const labelCss = {
	color: colors.text,
	fontWeight: typography.fontWeight.medium,
	fontSize: typography.fontSize.sm,
	padding: 0,
}

const fieldsetCss = {
	display: 'grid',
	gap: spacing.sm,
	margin: 0,
	padding: 0,
	border: 'none',
	minWidth: 0,
}

const optionCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.sm,
	cursor: 'pointer',
	'& input': { marginTop: '0.25rem' },
	'&:has(input:disabled)': { cursor: 'not-allowed' },
}

const optionTextCss = { display: 'grid', gap: '0.1rem', minWidth: 0 }

const optionLabelCss = { fontWeight: 650 }

const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}
