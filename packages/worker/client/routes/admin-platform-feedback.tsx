import { formatTimestamp } from '#client/format-timestamp.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	type AdminPlatformFeedbackLoaderData,
	type AdminPlatformFeedbackListItem,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { type Handle, css } from 'remix/ui'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	RecordTable,
	RecordTableSelect,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'

type PageStatus = 'loading' | 'ready' | 'error'

type FeedbackFilterState = {
	status: string
	category: string
}

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
	{ value: 'cancellation', label: 'Cancellation' },
	{ value: 'other', label: 'Other' },
] as const

const summaryPreviewCss = css(recordCellClamp(32))

const untrustedTextCss = css({
	margin: 0,
	whiteSpace: 'pre-wrap',
	overflowWrap: 'anywhere',
	fontFamily: 'inherit',
})

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
	url.searchParams.set('feedbackId', feedbackId)
	return routes.adminPlatformFeedback.href(null, {
		searchParams: url.searchParams,
	})
}

function buildPageHref(currentHref: string, page: number) {
	const url = new URL(currentHref, 'http://localhost')
	url.searchParams.delete('feedbackId')
	if (page <= 1) url.searchParams.delete('page')
	else url.searchParams.set('page', String(page))
	return routes.adminPlatformFeedback.href(null, {
		searchParams: url.searchParams,
	})
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
	return routes.adminPlatformFeedback.href(null, {
		searchParams: url.searchParams,
	})
}

function feedbackTitle(feedback: AdminPlatformFeedbackListItem) {
	return `${feedback.category}: ${feedback.summary_untrusted}`
}

export async function adminPlatformFeedbackRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(
		routes.adminPlatformFeedbackApi.href(null, {
			searchParams: url.searchParams,
		}),
		{
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		},
	)
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
	let data: AdminPlatformFeedbackLoaderData | null = null
	let message: string | null = null
	/** Payload last applied to the closure state above. */
	let appliedPayload: AdminPlatformFeedbackLoaderData | null = null
	let appliedError: Error | null = null
	const feedbackData = createRouteData({
		key: 'adminPlatformFeedback',
		async load(href, signal) {
			const response = await fetch(
				routes.adminPlatformFeedbackApi.href(null, {
					searchParams: new URL(href, 'http://localhost').searchParams,
				}),
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
					signal,
				},
			)
			if (response.status === 401) return routeDataRedirect(routes.login.href())
			if (response.status === 403) {
				throw new Error('You do not have permission to view platform feedback.')
			}
			const payload = await readJson<AdminPlatformFeedbackLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load platform feedback.')
			}
			return payload
		},
	})

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = feedbackData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			data = snapshot.data
			message = null
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			message = snapshot.error.message
		}
		const pending = snapshot.kind === 'pending'
		const status: PageStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'

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
			<AccountManagementShell
				maxWidth="min(100%, 92rem)"
				busy={pending && appliedPayload !== null}
			>
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
							{/* Lived on the queue sidebar until the table replaced it; it
							    belongs with the other read-this-first framing anyway. */}
							<p mix={css({ margin: 0 })}>
								Table rows omit full details and account contact information.
								Opening an entry is audit logged.
							</p>
						</section>

						<RecordTable
							mode="expand"
							busy={pending}
							ariaLabel="Platform feedback queue"
							selectedId={selectedFeedbackId}
							countLabel={`${data.total} submission${data.total === 1 ? '' : 's'}`}
							emptyLabel="No platform feedback matches this view."
							toolbar={
								<>
									<RecordTableSelect
										label="Filter feedback by status"
										value={filters.status}
										onChange={(value) => {
											replaceLocation(
												buildHrefWithUpdatedFilters(currentHref, {
													status: value,
												}),
											)
										}}
									>
										{statusOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</RecordTableSelect>
									<RecordTableSelect
										label="Filter feedback by category"
										value={filters.category}
										onChange={(value) => {
											replaceLocation(
												buildHrefWithUpdatedFilters(currentHref, {
													category: value,
												}),
											)
										}}
									>
										{categoryOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</RecordTableSelect>
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
								</>
							}
							columns={[
								{ key: 'category', label: 'Category', primary: true },
								{ key: 'summary', label: 'Summary', drop: 1 },
								{ key: 'status', label: 'Status' },
								{ key: 'id', label: 'Feedback id', drop: 3 },
								{ key: 'created', label: 'Created' },
							]}
							rows={data.feedback.map((feedback) => ({
								id: feedback.id,
								href: buildFeedbackHref(currentHref, feedback.id),
								cells: {
									category: feedback.category,
									summary: feedback.summary_untrusted ? (
										<span mix={summaryPreviewCss}>
											{feedback.summary_untrusted}
										</span>
									) : null,
									status: feedback.status,
									id: (
										<code
											mix={css({
												fontSize: '0.8rem',
												color: colors.textMuted,
												whiteSpace: 'nowrap',
											})}
										>
											{feedback.id}
										</code>
									),
									created: (
										<span mix={css(recordStampCss)}>
											{formatTimestamp(feedback.created_at)}
										</span>
									),
								},
							}))}
							footer={
								totalPages > 1 ? (
									<nav
										aria-label="Feedback pages"
										mix={css({
											display: 'flex',
											alignItems: 'center',
											justifyContent: 'center',
											gap: spacing.sm,
											flexWrap: 'wrap',
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
								) : null
							}
							record={
								selectedFeedback ? (
									<div mix={css(recordBodyCss)}>
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
													value: (
														<IdValue
															value={
																selectedFeedback.submitter?.user_id ??
																selectedFeedback.submitter_user_id
															}
															label="stable user ID"
														/>
													),
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
													value: (
														<TimestampValue
															value={selectedFeedback.created_at}
														/>
													),
												},
												{
													label: 'Updated',
													value: (
														<TimestampValue
															value={selectedFeedback.updated_at}
														/>
													),
												},
												{
													label: 'Reviewed',
													value: (
														<TimestampValue
															value={selectedFeedback.reviewed_at}
															fallback="Never"
														/>
													),
												},
												{
													label: 'Reviewer ID',
													value: selectedFeedback.reviewed_by_user_id ? (
														<IdValue
															value={selectedFeedback.reviewed_by_user_id}
															label="reviewer ID"
														/>
													) : (
														'None'
													),
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
									</div>
								) : null
							}
						/>
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
