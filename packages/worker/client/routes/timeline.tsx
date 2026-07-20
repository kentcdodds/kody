import { type Handle, css } from 'remix/ui'
import {
	communityActivityVerb,
	formatCommunityActivityDate,
} from '#app/community-activity-display.ts'
import { type PublicCommunityActivityItem } from '#app/community-public-types.ts'
import { type TimelineLoaderData } from '#app/loader-data.ts'
import { routes } from '#app/routes.ts'
import { UserAvatar } from '#app/user-avatar.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	descriptionCss,
	layoutMaxWidths,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

const timelineApiPath = routes.timelineApi.href()

function isTimelinePath(href: string) {
	return new URL(href, 'http://localhost').pathname === routes.timeline.href()
}

export async function timelineRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(timelineApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<TimelineLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load your timeline.')
	}
	return { timeline: payload }
}

export function TimelineRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' = 'loading'
	let items: Array<PublicCommunityActivityItem> = []
	const loadLatch = createRouteLoadLatch()

	async function loadTimeline() {
		status = 'loading'
		handle.update()
		try {
			const response = await fetch(timelineApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<TimelineLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load your timeline.')
			}
			items = payload.items
			status = 'ready'
			handle.update()
		} catch {
			status = 'error'
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (!isTimelinePath(currentHref)) {
			return <section mix={css(pageCss)} />
		}

		const routeData = tryConsumeRouteLoaderData(handle, 'timeline', currentHref)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			items = routeData.items
			status = 'ready'
			loadLatch.markLoaded(currentHref)
		}

		const needsStaleRefresh = consumeStaleNavigationData(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(async () => {
				try {
					await loadTimeline()
					if (status === 'ready') loadLatch.markLoaded(currentHref)
					else loadLatch.markFailed(currentHref)
				} catch {
					loadLatch.markFailed(currentHref)
				}
			})
		}

		return (
			<section mix={css(pageCss)} data-testid="timeline-page">
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>Timeline</h1>
					<p mix={css(pageDescriptionCss)}>
						Public activity from people you follow.
					</p>
				</header>

				{status === 'loading' ? (
					<p mix={css(descriptionCss)}>Loading timeline…</p>
				) : null}
				{status === 'error' ? (
					<p mix={css(descriptionCss)} role="status">
						Unable to load your timeline.
					</p>
				) : null}
				{status === 'ready' && items.length === 0 ? (
					<p mix={css(descriptionCss)} data-testid="timeline-empty">
						Follow community members to see their public activity.{' '}
						<a href={routes.community.href()} mix={css(mutedLinkCss)}>
							Browse community packages
						</a>
					</p>
				) : null}
				{status === 'ready' && items.length > 0 ? (
					<ul mix={css(listCss)}>
						{items.map((item) => (
							<li
								key={`${item.type}:${item.actorUsername}:${item.listingId}:${item.createdAt}`}
								mix={css(itemCss)}
							>
								<p mix={css(actorRowCss)}>
									<UserAvatar
										displayName={item.actorDisplayName}
										avatarUrl={item.actorAvatarUrl}
										size={36}
									/>
									<span>
										<a
											href={routes.profile.href({
												username: item.actorUsername,
											})}
											mix={css(mutedLinkCss)}
										>
											{item.actorDisplayName}
										</a>{' '}
										{communityActivityVerb(item.type).toLowerCase()}{' '}
										<a
											href={routes.communityDetail.href({
												listingId: item.listingId,
											})}
											mix={css(mutedLinkCss)}
										>
											{item.listingName}
										</a>
									</span>
								</p>
								<time
									dateTime={item.createdAt}
									mix={css(timeCss)}
									title={item.createdAt}
								>
									{formatCommunityActivityDate(item.createdAt)}
								</time>
							</li>
						))}
					</ul>
				) : null}
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: layoutMaxWidths.extended,
	margin: '0 auto',
	width: '100%',
}

const listCss = {
	display: 'grid',
	gap: spacing.md,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const itemCss = {
	display: 'grid',
	gap: spacing.xs,
	paddingBottom: spacing.md,
	borderBottom: `1px solid ${colors.border}`,
}

const actorRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	margin: 0,
}

const timeCss = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
