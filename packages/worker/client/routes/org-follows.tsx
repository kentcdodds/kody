import { css, type Handle } from 'remix/component'
import { createDoubleCheck } from '#client/double-check.ts'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { formatTimestampDate } from '#client/format-timestamp.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import {
	describeFollowEvents,
	describePausedFollow,
	followDeliveryNote,
	followPostErrorMessage,
	followPausedRetentionNote,
	postOrgFollow,
} from '#client/routes/follows-shared.ts'
import {
	followEventCopy,
	followSkipReasonCopy,
	type OrgFollowRow,
	type OrgFollowsLoaderData,
} from '#universal/follows.ts'
import { renderIcon } from '#universal/icon.tsx'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	nativeDisclosureCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

type FollowsPayload = OrgFollowsLoaderData | { ok: false; error?: string }

async function fetchFollows(
	slug: string,
	signal: AbortSignal,
): Promise<OrgFollowsLoaderData | 'unauthorized' | 'not-found'> {
	const response = await fetch(routes.orgFollowsApi.href({ orgSlug: slug }), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) return 'unauthorized'
	if (response.status === 404) return 'not-found'
	const payload = (await response
		.json()
		.catch(() => null)) as FollowsPayload | null
	if (!response.ok || !payload?.ok) {
		throw new Error(
			(payload && !payload.ok ? payload.error : null) ||
				'Unable to load follows.',
		)
	}
	return payload
}

function orgFollowsSlugFromHref(href: string) {
	const match = /^\/@([^/]+)\/-\/follows\/?$/.exec(
		new URL(href, 'http://localhost').pathname,
	)
	return match?.[1] ?? ''
}

export async function orgFollowsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const payload = await fetchFollows(
		orgFollowsSlugFromHref(url.pathname),
		signal,
	)
	if (payload === 'unauthorized') return routeLoaderRedirect('/login')
	if (payload === 'not-found') {
		return routeLoaderRedirect(routes.notFoundPage.href())
	}
	return { orgFollows: payload }
}

export function OrgFollowsRoute(handle: Handle) {
	const followsData = createRouteData({
		key: 'orgFollows',
		async load(href, signal) {
			const payload = await fetchFollows(orgFollowsSlugFromHref(href), signal)
			if (payload === 'unauthorized') return routeDataRedirect('/login')
			if (payload === 'not-found') throw new Error('Organization unavailable.')
			return payload
		},
	})

	const unfollowChecks = new Map<string, ReturnType<typeof createDoubleCheck>>()
	let busyFollowId: string | null = null
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'

	function unfollowCheckFor(followId: string) {
		const existing = unfollowChecks.get(followId)
		if (existing) return existing
		const created = createDoubleCheck(handle)
		unfollowChecks.set(followId, created)
		return created
	}

	async function mutate(follow: OrgFollowRow, intent: 'unfollow' | 'resume') {
		const snapshot = followsData.read(handle, readCurrentRouterHref(handle))
		const data = snapshot.data
		if (!data?.ok || busyFollowId) return
		busyFollowId = follow.id
		message = null
		handle.update()
		const payload = await postOrgFollow(
			data.orgSlug,
			intent === 'unfollow'
				? { intent: 'unfollow', id: follow.id }
				: { intent: 'follow', id: follow.id },
		).catch(() => null)
		busyFollowId = null
		if (payload?.ok) {
			if (intent === 'unfollow') unfollowChecks.delete(follow.id)
			message =
				intent === 'unfollow'
					? `Unfollowed ${follow.name}.`
					: payload.follow?.status === 'active'
						? `Following ${follow.name} again.`
						: `${follow.name} is still paused.`
			messageTone =
				intent === 'resume' && payload.follow?.status !== 'active'
					? 'error'
					: 'info'
			followsData.reload(handle, readCurrentRouterHref(handle))
		} else {
			if (payload?.code === 'unauthorized') {
				window.location.assign('/login')
				return
			}
			message = payload
				? followPostErrorMessage(payload)
				: 'Unable to update this follow.'
			messageTone = 'error'
		}
		handle.update()
	}

	return () => {
		const href = readCurrentRouterHref(handle)
		const snapshot = followsData.read(handle, href)
		const data = snapshot.data
		const pending = snapshot.kind === 'pending'

		return (
			<AccountManagementShell busy={pending && Boolean(data)}>
				<AccountPageHeader
					title="Follows"
					description="Packages and repositories this workspace follows. Their new versions and pushes arrive here as events."
					currentHref={href}
				/>
				{snapshot.kind === 'error' ? (
					<AccountManagementMessage tone="error">
						{snapshot.error?.message ?? 'Unable to load follows.'}
					</AccountManagementMessage>
				) : null}
				{!data && pending ? (
					<p role="status" mix={css(mutedCopyCss)}>
						Loading follows…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				{data?.ok ? (
					<AccountManagementPanel title="Following" ariaLabel="Follows">
						{data.follows.length === 0 ? (
							<p mix={css(mutedCopyCss)} data-testid="org-follows-empty">
								Not following anything yet. Open a package or repository and
								choose Follow. Browse{' '}
								<a href={routes.community.href()}>Community</a> to find one.
							</p>
						) : (
							<ul mix={css(listCss)} data-testid="org-follows">
								{data.follows.map((follow) =>
									renderFollowRow(follow, {
										busy: busyFollowId === follow.id,
										check: unfollowCheckFor(follow.id),
										onUnfollow: () => void mutate(follow, 'unfollow'),
										onResume: () => void mutate(follow, 'resume'),
									}),
								)}
							</ul>
						)}
						<p mix={css(noteCss)}>
							{followDeliveryNote} {followPausedRetentionNote}
						</p>
					</AccountManagementPanel>
				) : null}
			</AccountManagementShell>
		)
	}
}

function renderFollowRow(
	follow: OrgFollowRow,
	input: {
		busy: boolean
		check: ReturnType<typeof createDoubleCheck>
		onUnfollow(): void
		onResume(): void
	},
) {
	const paused = describePausedFollow(follow)
	const skipped = followSkipReasonCopy(follow.lastDeliverySkipReason)
	return (
		<li
			key={follow.id}
			data-testid="org-follow"
			data-follow-status={follow.status}
			mix={css(rowItemCss)}
		>
			<div mix={css(rowCss)}>
				<span aria-hidden="true" mix={css(iconCss)}>
					{renderIcon(follow.status === 'paused' ? 'pause' : 'eye', {
						size: '1.25rem',
					})}
				</span>
				<span mix={css(rowTextCss)}>
					<span mix={css(rowNameLineCss)}>
						{follow.href ? (
							<a href={follow.href} mix={css(rowNameCss)}>
								{follow.name}
							</a>
						) : (
							<span mix={css(rowNameCss)}>{follow.name}</span>
						)}
						<span
							data-testid="org-follow-status"
							mix={css(
								follow.status === 'paused' ? pausedChipCss : activeChipCss,
							)}
						>
							{follow.status === 'paused' ? 'Paused' : 'Active'}
						</span>
					</span>
					<span mix={css(rowDetailCss)}>
						{follow.kind === 'repo' ? 'Repository' : 'Package'} ·{' '}
						{describeFollowEvents(follow.events)}
					</span>
					{paused ? (
						<span data-testid="org-follow-paused" mix={css(rowWarningCss)}>
							{paused}
							{follow.deleteAt
								? ` It will be deleted on ${formatTimestampDate(follow.deleteAt)} unless access comes back and you resume it.`
								: null}
						</span>
					) : null}
					{skipped ? (
						<span data-testid="org-follow-skipped" mix={css(rowWarningCss)}>
							{skipped}
						</span>
					) : null}
				</span>
				<span mix={css(rowActionsCss)}>
					{follow.status === 'paused' ? (
						<button
							type="button"
							data-testid="org-follow-resume"
							disabled={input.busy}
							mix={[
								css(getGhostButtonCss({ size: 'sm' })),
								on('click', input.onResume),
							]}
						>
							{renderIcon('play', { size: '1.05rem' })}
							Resume
						</button>
					) : null}
					<button
						type="button"
						data-testid="org-follow-unfollow"
						disabled={input.busy}
						mix={[
							css(getDangerPillCss({ size: 'sm' })),
							...input.check.getButtonMix({
								on: { click: input.onUnfollow },
							}),
						]}
					>
						{renderIcon('close', { size: '1.05rem' })}
						{input.check.doubleCheck ? 'Confirm unfollow' : 'Unfollow'}
					</button>
				</span>
			</div>
			<details
				mix={css({
					...nativeDisclosureCss,
					paddingInline: '1rem',
					paddingBottom: '0.35rem',
				})}
			>
				<summary>Details</summary>
				<div>
					<MetadataGrid
						items={[
							{
								label: 'Follow ID',
								value: <IdValue value={follow.id} label="follow ID" />,
							},
							{
								label: 'Following since',
								value: <TimestampValue value={follow.createdAt} />,
							},
							{
								label: 'Event topics',
								value: follow.events.length
									? follow.events
											.map((event) => followEventCopy[event].topic)
											.join(', ')
									: 'None',
							},
							...(follow.pausedAt
								? [
										{
											label: 'Paused',
											value: <TimestampValue value={follow.pausedAt} />,
										},
									]
								: []),
							...(follow.lastDeliverySkipAt
								? [
										{
											label: 'Last skipped delivery',
											value: (
												<TimestampValue value={follow.lastDeliverySkipAt} />
											),
										},
									]
								: []),
						]}
					/>
				</div>
			</details>
		</li>
	)
}

const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.5,
}

const noteCss = {
	...mutedCopyCss,
	fontSize: typography.fontSize.sm,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const rowItemCss = {
	minWidth: 0,
	display: 'grid',
	gap: '0.25rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem 0',
}

const rowTextCss = {
	display: 'grid',
	gap: '0.2rem',
	minWidth: 0,
	flex: '1 1 16rem',
}

const rowNameLineCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	color: colors.text,
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const rowWarningCss = {
	fontSize: typography.fontSize.sm,
	color: colors.text,
	lineHeight: 1.45,
}

const rowActionsCss = {
	display: 'flex',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
}

const chipBaseCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: '0.1rem 0.5rem',
	borderRadius: radius.full,
	fontSize: typography.fontSize.xs,
	fontWeight: 650,
	flexShrink: 0,
}

const activeChipCss = {
	...chipBaseCss,
	color: colors.primaryText,
	border: `1px solid ${colors.primary}`,
}

const pausedChipCss = {
	...chipBaseCss,
	color: colors.textMuted,
	border: `1px solid ${colors.border}`,
}

const iconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
	flexShrink: 0,
}
