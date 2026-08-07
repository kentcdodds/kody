import {
	formatNullableTimestamp,
	formatTimestamp,
} from '#client/format-timestamp.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { replaceLocation } from '#client/replace-location.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readRouterSearch } from '#client/router-location.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getSelectCss,
} from '#client/styles/style-primitives.ts'
import {
	type AdminPlatformFeedbackLoaderData,
	type AdminPlatformFeedbackListItem,
} from '#app/loader-data.ts'
import { routes } from '#app/routes.ts'
import { type Handle, css } from 'remix/ui'
import {
	AccountManagementLayout,
	AccountManagementList,
	AccountManagementListItemLink,
	AccountManagementMessage,
	AccountManagementShell,
	AccountManagementSidebar,
	AdminPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'

const selectCss = getSelectCss()

type PageStatus = 'loading' | 'ready' | 'error'

type FeedbackFilterState = {
	status: string
	category: string
}

const adminPlatformFeedbackApiPath = routes.adminPlatformFeedbackApi.href()

const statusOptions = [
	{ value: '', label: 'All statuses' },
	{ value: 'open', label: 'Open' },
	{ value: 'triaged', label: 'Triaged' },
	{ value: 'resolved', label: 'Resolved' },
	{ value: 'dismissed', label: 'Dismissed' },
] as const

const categoryOptions = [
	{ value: '', label: 'All categories' },
	{ value: 'friction', label: 'Friction' },
	{ value: 'bug', label: 'Bug' },
	{ value: 'experience', label: 'Experience' },
	{ value: 'suggestion', label: 'Suggestion' },
	{ value: 'other', label: 'Other' },
] as const

const truncatedTextCss = {
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
} as const

const untrustedTextCss = css({
	margin: 0,
	whiteSpace: 'pre-wrap',
	overflowWrap: 'anywhere',
	fontFamily: 'inherit',
})

function isAdminPlatformFeedbackPath(href: string) {
	return (
		new URL(href, 'http://localhost').pathname ===
		routes.adminPlatformFeedback.href()
	)
}

function readFilterState(href: string): FeedbackFilterState {
	const url = new URL(href, 'http://localhost')
	return {
		status: url.searchParams.get('status')?.trim() ?? '',
		category: url.searchParams.get('category')?.trim() ?? '',
	}
}

function readSelectedFeedbackId(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('feedbackId')
}

function buildFeedbackHref(currentHref: string, feedbackId: string) {
	const url = new URL(currentHref, 'http://localhost')
	url.pathname = routes.adminPlatformFeedback.href()
	url.searchParams.set('feedbackId', feedbackId)
	return `${url.pathname}${url.search}`
}

function buildPageHref(currentHref: string, page: number) {
	const url = new URL(currentHref, 'http://localhost')
	url.pathname = routes.adminPlatformFeedback.href()
	url.searchParams.delete('feedbackId')
	if (page <= 1) url.searchParams.delete('page')
	else url.searchParams.set('page', String(page))
	return `${url.pathname}${url.search}`
}

function buildHrefWithUpdatedFilters(
	currentHref: string,
	nextFilters: Partial<FeedbackFilterState>,
) {
	const url = new URL(currentHref, 'http://localhost')
	const filters = { ...readFilterState(url.toString()), ...nextFilters }
	if (filters.status) url.searchParams.set('status', filters.status)
	else url.searchParams.delete('status')
	if (filters.category) url.searchParams.set('category', filters.category)
	else url.searchParams.delete('category')
	// Filter changes re-anchor the list and clear the detail selection.
	url.searchParams.delete('feedbackId')
	url.searchParams.delete('page')
	return `${url.pathname}${url.search}`
}

function feedbackTitle(feedback: AdminPlatformFeedbackListItem) {
	return `${feedback.category}: ${feedback.summary_untrusted}`
}

export async function adminPlatformFeedbackRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${adminPlatformFeedbackApiPath}${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect(routes.login.href())
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view platform feedback.')
	}
	const payload = await readJson<AdminPlatformFeedbackLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load platform feedback.')
	}
	return { adminPlatformFeedback: payload }
}

export function AdminPlatformFeedbackRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let data: AdminPlatformFeedbackLoaderData | null = null
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	function applyData(payload: AdminPlatformFeedbackLoaderData, href: string) {
		data = payload
		status = 'ready'
		message = null
		lastLoadedHref = href
		lastFailedHref = null
	}

	async function loadPlatformFeedback() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(
				`${adminPlatformFeedbackApiPath}${readRouterSearch(handle)}`,
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign(routes.login.href())
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view platform feedback.'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminPlatformFeedbackLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load platform feedback.')
			}
			applyData(payload, href)
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load platform feedback.'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isAdminPlatformFeedbackPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'adminPlatformFeedback',
			href,
		)
		if (!routeData) return false
		applyData(routeData, href)
		return true
	}

	let lastSeenHref = ''

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (currentHref !== lastSeenHref) {
			lastSeenHref = currentHref
			lastFailedHref = null
		}
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!appliedRouteData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadPlatformFeedback)
		}

		const selectedFeedback = data?.selectedFeedback ?? null
		const selectedFeedbackId = readSelectedFeedbackId(currentHref)
		// Read filters from the URL (not the loader payload) so the selects
		// don't snap back to stale values while a reload is in flight.
		const filters = readFilterState(currentHref)
		const totalPages = data
			? Math.max(1, Math.ceil(data.total / data.pageSize))
			: 1
		const hasActiveFilters = Boolean(filters.status || filters.category)

		return (
			<AccountManagementShell maxWidth="min(100%, 92rem)">
				<AdminPageHeader
					title="Platform feedback"
					description="Read attributed feedback that users explicitly approved for admin review."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading platform feedback…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				{data ? (
					<>
						<section
							aria-label="Content warning"
							mix={css({
								...cardCss,
								borderColor: colors.danger,
								backgroundColor:
									'color-mix(in srgb, var(--color-danger) 8%, var(--color-surface))',
							})}
						>
							<strong>Content warning: untrusted user-authored text</strong>
							<p mix={css({ margin: 0 })}>{data.content_warning}</p>
						</section>

						<AccountManagementLayout
							sidebar={
								<AccountManagementSidebar
									title="Feedback queue"
									description={`${data.total} submission${data.total === 1 ? '' : 's'} match this view. List rows omit full details and account contact information.`}
								>
									<div mix={css({ display: 'grid', gap: spacing.sm })}>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Status</span>
											<select
												data-field-ring
												value={filters.status}
												aria-label="Filter feedback by status"
												mix={[
													on('change', (event) => {
														replaceLocation(
															buildHrefWithUpdatedFilters(currentHref, {
																status: event.currentTarget.value,
															}),
														)
													}),
													css(selectCss),
												]}
											>
												{statusOptions.map((option) => (
													<option key={option.value} value={option.value}>
														{option.label}
													</option>
												))}
											</select>
										</label>
										<label mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Category</span>
											<select
												data-field-ring
												value={filters.category}
												aria-label="Filter feedback by category"
												mix={[
													on('change', (event) => {
														replaceLocation(
															buildHrefWithUpdatedFilters(currentHref, {
																category: event.currentTarget.value,
															}),
														)
													}),
													css(selectCss),
												]}
											>
												{categoryOptions.map((option) => (
													<option key={option.value} value={option.value}>
														{option.label}
													</option>
												))}
											</select>
										</label>
										{hasActiveFilters ? (
											<button
												type="button"
												mix={[
													on('click', () => {
														replaceLocation(
															buildHrefWithUpdatedFilters(currentHref, {
																status: '',
																category: '',
															}),
														)
													}),
													css(secondaryButtonCss),
												]}
											>
												Clear filters
											</button>
										) : null}
									</div>

									{data.feedback.length === 0 ? (
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											No platform feedback matches this view.
										</p>
									) : (
										<AccountManagementList>
											{data.feedback.map((feedback) => {
												const isActive = selectedFeedbackId === feedback.id
												return (
													<li key={feedback.id} mix={css({ minWidth: 0 })}>
														<AccountManagementListItemLink
															href={buildFeedbackHref(currentHref, feedback.id)}
															active={isActive}
														>
															<strong
																mix={css({
																	...truncatedTextCss,
																	display: 'block',
																})}
															>
																{feedback.category}
															</strong>
															<span
																mix={css({
																	...truncatedTextCss,
																	display: 'block',
																	fontSize: typography.fontSize.xs,
																	color: colors.textMuted,
																})}
															>
																{feedback.status} ·{' '}
																{formatTimestamp(feedback.created_at)} ·{' '}
																{feedback.id}
															</span>
															{feedback.summary_untrusted ? (
																<span
																	mix={css({
																		display: '-webkit-box',
																		fontSize: typography.fontSize.sm,
																		color: colors.textMuted,
																		overflow: 'hidden',
																		overflowWrap: 'anywhere',
																		textOverflow: 'ellipsis',
																		'-webkit-box-orient': 'vertical',
																		'-webkit-line-clamp': '2',
																	})}
																>
																	{feedback.summary_untrusted}
																</span>
															) : null}
														</AccountManagementListItemLink>
													</li>
												)
											})}
										</AccountManagementList>
									)}

									{totalPages > 1 ? (
										<nav
											aria-label="Feedback pages"
											mix={css({
												display: 'flex',
												alignItems: 'center',
												gap: spacing.sm,
												flexWrap: 'wrap',
												marginTop: spacing.sm,
											})}
										>
											{data.page > 1 ? (
												<a
													href={buildPageHref(currentHref, data.page - 1)}
													mix={css({
														...secondaryButtonCss,
														textDecoration: 'none',
													})}
												>
													Previous
												</a>
											) : null}
											<span
												mix={css({
													color: colors.textMuted,
													fontSize: typography.fontSize.xs,
												})}
											>
												Page {data.page} of {totalPages}
											</span>
											{data.page < totalPages ? (
												<a
													href={buildPageHref(currentHref, data.page + 1)}
													mix={css({
														...secondaryButtonCss,
														textDecoration: 'none',
													})}
												>
													Next
												</a>
											) : null}
										</nav>
									) : null}
								</AccountManagementSidebar>
							}
						>
							<div
								mix={css({
									...cardCss,
									gap: spacing.lg,
								})}
							>
								{selectedFeedback ? (
									<>
										<div mix={css({ display: 'grid', gap: spacing.xs })}>
											<h2
												mix={css({
													margin: 0,
													fontSize: typography.fontSize.lg,
													fontWeight: typography.fontWeight.semibold,
													color: colors.text,
												})}
											>
												{feedbackTitle(selectedFeedback)}
											</h2>
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												This detail read is audit logged.
											</p>
										</div>

										<MetadataGrid
											columns={3}
											items={[
												{
													label: 'Submitter username',
													value:
														selectedFeedback.submitter?.username ??
														'Account unavailable',
												},
												{
													label: 'Submitter email',
													value:
														selectedFeedback.submitter?.email ??
														'Account unavailable',
												},
												{
													label: 'Stable user ID',
													value:
														selectedFeedback.submitter?.user_id ??
														selectedFeedback.submitter_user_id,
												},
												{
													label: 'Category',
													value: selectedFeedback.category,
												},
												{
													label: 'Status',
													value: selectedFeedback.status,
												},
												{
													label: 'Created',
													value: formatTimestamp(selectedFeedback.created_at),
												},
												{
													label: 'Updated',
													value: formatTimestamp(selectedFeedback.updated_at),
												},
												{
													label: 'Reviewed',
													value: formatNullableTimestamp(
														selectedFeedback.reviewed_at,
													),
												},
												{
													label: 'Reviewer ID',
													value: selectedFeedback.reviewed_by_user_id ?? 'None',
												},
											]}
										/>

										<section mix={css(cardCss)}>
											<strong>Summary (untrusted)</strong>
											<pre mix={untrustedTextCss}>
												{selectedFeedback.summary_untrusted}
											</pre>
										</section>
										<section mix={css(cardCss)}>
											<strong>Details (untrusted)</strong>
											<pre mix={untrustedTextCss}>
												{selectedFeedback.details_untrusted}
											</pre>
										</section>
										<section mix={css(cardCss)}>
											<strong>Admin note</strong>
											{selectedFeedback.admin_note ? (
												<pre mix={untrustedTextCss}>
													{selectedFeedback.admin_note}
												</pre>
											) : (
												<p mix={css({ margin: 0, color: colors.textMuted })}>
													No admin note.
												</p>
											)}
										</section>
									</>
								) : (
									<div mix={css({ display: 'grid', gap: spacing.sm })}>
										<h2
											mix={css({
												margin: 0,
												fontSize: typography.fontSize.lg,
												fontWeight: typography.fontWeight.semibold,
												color: colors.text,
											})}
										>
											Select a feedback entry
										</h2>
										<p mix={css({ margin: 0, color: colors.textMuted })}>
											Pick an entry from the queue to review it.
										</p>
									</div>
								)}
							</div>
						</AccountManagementLayout>
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
