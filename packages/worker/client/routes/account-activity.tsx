import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createListDetailRoute } from '#client/list-detail-route.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	accountManagementNarrowMq,
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from '#client/routes/account-management-components.tsx'
import {
	RecordTable,
	RecordTableSelect,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
} from '#client/routes/record-table.tsx'
import {
	type AccountActivityLoaderData,
	type AccountActivityRunDetail,
	type AccountActivityRunListItem,
	type AccountActivityStatusFilter,
	type AccountActivitySurfaceFilter,
	type AccountActivitySummary,
	type AccountActivityTriageFilter,
} from '#app/loader-data.ts'
import { colors, radius, spacing, typography } from '#client/styles/tokens.ts'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
} from '#client/styles/style-primitives.ts'

const clampedCellCss = css(recordCellClamp(30))

const activityErrorReviewPrompt = [
	'Look at my open Kody activity errors.',
	'Start with run_summary, then run_list for open errors, and run_get on the ones that matter.',
	'Explain each failure and recommend whether to ignore it, mark it resolved, or fix something.',
].join(' ')

const accountActivityApiPath = '/account/activity.json'
const activityRoute = createListDetailRoute('/account/activity')

const statusFilterOptions: Array<{
	value: AccountActivityStatusFilter
	label: string
}> = [
	{ value: 'error', label: 'Errors' },
	{ value: 'all', label: 'All' },
	{ value: 'running', label: 'Running' },
]

const triageFilterOptions: Array<{
	value: AccountActivityTriageFilter
	label: string
}> = [
	{ value: 'open', label: 'Open' },
	{ value: 'ignored', label: 'Ignored' },
	{ value: 'resolved', label: 'Resolved' },
	{ value: 'all', label: 'All triage' },
]

const surfaceFilterOptions: Array<{
	value: AccountActivitySurfaceFilter
	label: string
}> = [
	{ value: 'all', label: 'All surfaces' },
	{ value: 'execute', label: 'Execute' },
	{ value: 'export', label: 'Export' },
	{ value: 'subscription', label: 'Subscription' },
	{ value: 'app_fetch', label: 'App fetch' },
	{ value: 'app_realtime', label: 'App realtime' },
	{ value: 'service', label: 'Service' },
	{ value: 'job', label: 'Job' },
	{ value: 'workflow', label: 'Workflow' },
	{ value: 'retriever', label: 'Retriever' },
	{ value: 'webhook', label: 'Webhook' },
]

function surfaceLabel(surface: AccountActivityRunListItem['surface']) {
	const match = surfaceFilterOptions.find((option) => option.value === surface)
	return match?.label ?? surface
}

function statusLabel(status: AccountActivityRunListItem['status']) {
	switch (status) {
		case 'error':
			return 'Error'
		case 'success':
			return 'Success'
		case 'running':
			return 'Running'
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

function statusColor(status: AccountActivityRunListItem['status']) {
	switch (status) {
		case 'error':
			return colors.error
		case 'success':
			return colors.primary
		case 'running':
			return colors.textMuted
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

function logLevelColor(
	level: AccountActivityRunDetail['logs'][number]['level'],
) {
	switch (level) {
		case 'error':
			return colors.error
		case 'warn':
			return colors.dangerHover
		case 'debug':
			return colors.textMuted
		case 'info':
		case 'log':
			return colors.text
		default: {
			const exhaustive: never = level
			return exhaustive
		}
	}
}

function formatDurationMs(durationMs: number | null) {
	if (durationMs == null) return '—'
	if (durationMs < 1000) return `${durationMs} ms`
	return `${(durationMs / 1000).toFixed(1)} s`
}

function runDisplayName(run: AccountActivityRunListItem) {
	return run.name?.trim() || surfaceLabel(run.surface)
}

function readStatusFilter(href: string): AccountActivityStatusFilter {
	const value = new URL(href, 'http://localhost').searchParams
		.get('status')
		?.trim()
	if (value === 'all' || value === 'running' || value === 'error') return value
	return 'error'
}

function readSurfaceFilter(href: string): AccountActivitySurfaceFilter {
	const value = new URL(href, 'http://localhost').searchParams
		.get('surface')
		?.trim()
	const match = surfaceFilterOptions.find((option) => option.value === value)
	return match?.value ?? 'all'
}

function readTriageFilter(href: string): AccountActivityTriageFilter {
	const params = new URL(href, 'http://localhost').searchParams
	const value =
		params.get('error_triage')?.trim() ?? params.get('triage')?.trim()
	const match = triageFilterOptions.find((option) => option.value === value)
	return match?.value ?? 'open'
}

function triageLabel(
	run: Pick<AccountActivityRunListItem, 'status' | 'errorTriage'>,
) {
	if (run.status !== 'error') return '—'
	switch (run.errorTriage) {
		case 'ignored':
			return 'Ignored'
		case 'resolved':
			return 'Resolved'
		case null:
			return 'Open'
		default: {
			const exhaustive: never = run.errorTriage
			return exhaustive
		}
	}
}

function buildActivitySearch(input: {
	status: AccountActivityStatusFilter
	surface: AccountActivitySurfaceFilter
	triage: AccountActivityTriageFilter
}) {
	const params = new URLSearchParams()
	if (input.status !== 'error') params.set('status', input.status)
	if (input.surface !== 'all') params.set('surface', input.surface)
	if (input.triage !== 'open') params.set('error_triage', input.triage)
	const search = params.toString()
	return search ? `?${search}` : ''
}

function getDataLatchKey(href: string) {
	const selection = activityRoute.getSelection(href)
	const status = readStatusFilter(href)
	const surface = readSurfaceFilter(href)
	const triage = readTriageFilter(href)
	const filterKey = `${status}:${surface}:${triage}`
	return selection.selectedId
		? `/account/activity/${encodeURIComponent(selection.selectedId)}?${filterKey}`
		: `/account/activity?${filterKey}`
}

function buildActivityApiRequestUrl(href: string, cursor?: string | null) {
	const requestUrl = new URL(accountActivityApiPath, 'http://localhost')
	const status = readStatusFilter(href)
	const surface = readSurfaceFilter(href)
	const triage = readTriageFilter(href)
	if (status !== 'error') requestUrl.searchParams.set('status', status)
	else requestUrl.searchParams.set('status', 'error')
	if (surface !== 'all') requestUrl.searchParams.set('surface', surface)
	if (triage !== 'open') requestUrl.searchParams.set('error_triage', triage)
	const selectedRunId = activityRoute.getSelection(href).selectedId
	if (selectedRunId) {
		requestUrl.searchParams.set('selected', selectedRunId)
	}
	if (cursor) {
		requestUrl.searchParams.set('cursor', cursor)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountActivityRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildActivityApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountActivityLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load activity.')
	}
	return { accountActivity: payload }
}

function tryConsumeAccountActivityLoaderData(handle: Handle, href: string) {
	return tryConsumeRouteLoaderData(handle, 'accountActivity', href)
}

export function AccountActivityRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let runs: Array<AccountActivityRunListItem> = []
	let selectedRun: AccountActivityRunDetail | null = null
	let summary: AccountActivitySummary | null = null
	let nextCursor: string | null = null
	let retentionDays = 30
	let message: string | null = null
	let loadingMore = false
	const loadLatch = createRouteLoadLatch()
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function setMessage(nextMessage: string | null) {
		message = nextMessage
	}

	function applyPayload(
		payload: AccountActivityLoaderData,
		options?: { append?: boolean },
	) {
		if (options?.append) {
			const seen = new Set(runs.map((run) => run.id))
			runs = [...runs, ...payload.runs.filter((run) => !seen.has(run.id))]
		} else {
			runs = payload.runs
		}
		selectedRun = payload.selectedRun
		summary = payload.summary
		nextCursor = payload.nextCursor
		retentionDays = payload.retentionDays
	}

	async function loadActivity(signal: AbortSignal) {
		const href = getCurrentHref()
		const latchKey = getDataLatchKey(href)
		try {
			const response = await fetch(buildActivityApiRequestUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountActivityLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load activity.')
			}
			if (getDataLatchKey(getCurrentHref()) !== latchKey) return
			applyPayload(payload)
			setMessage(null)
			status = 'ready'
			loadLatch.markLoaded(latchKey)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			setMessage(
				error instanceof Error ? error.message : 'Unable to load activity.',
			)
			loadLatch.markFailed(latchKey)
			handle.update()
		}
	}

	async function loadMoreRuns() {
		if (loadingMore || !nextCursor) return
		loadingMore = true
		handle.update()
		const href = getCurrentHref()
		try {
			const response = await fetch(
				buildActivityApiRequestUrl(href, nextCursor),
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountActivityLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load more activity.')
			}
			applyPayload(payload, { append: true })
			loadingMore = false
			handle.update()
		} catch (error) {
			loadingMore = false
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to load more activity.',
			)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!activityRoute.isRoutePath(href)) return false
		const routeData = tryConsumeAccountActivityLoaderData(handle, href)
		if (!routeData) return false
		applyPayload(routeData)
		status = 'ready'
		loadLatch.markLoaded(getDataLatchKey(href))
		return true
	}

	function updateFilters(input: {
		status?: AccountActivityStatusFilter
		surface?: AccountActivitySurfaceFilter
		triage?: AccountActivityTriageFilter
	}) {
		const href = getCurrentHref()
		const selection = activityRoute.getSelection(href)
		const search = buildActivitySearch({
			status: input.status ?? readStatusFilter(href),
			surface: input.surface ?? readSurfaceFilter(href),
			triage: input.triage ?? readTriageFilter(href),
		})
		if (selection.selectedId) {
			navigate(activityRoute.buildDetailHref(selection.selectedId, search))
			return
		}
		replaceLocation(activityRoute.buildListHref(search))
	}

	return () => {
		const currentHref = getCurrentHref()
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const latchKey = getDataLatchKey(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref: latchKey,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadActivity)
		}

		const selection = activityRoute.getSelection(currentHref)
		const statusFilter = readStatusFilter(currentHref)
		const surfaceFilter = readSurfaceFilter(currentHref)
		const triageFilter = readTriageFilter(currentHref)
		const filterSearch = buildActivitySearch({
			status: statusFilter,
			surface: surfaceFilter,
			triage: triageFilter,
		})
		const detail =
			selectedRun && selectedRun.id === selection.selectedId
				? selectedRun
				: null
		const listMatch =
			runs.find((item) => item.id === selection.selectedId) ?? null
		const waitingForDetail =
			selection.selectedId != null &&
			!detail &&
			(needsLoad || listMatch != null || status === 'loading')
		const showRunNotFound =
			selection.selectedId != null &&
			!detail &&
			!waitingForDetail &&
			status === 'ready'
		const emptyBecauseErrors =
			statusFilter === 'error' &&
			surfaceFilter === 'all' &&
			triageFilter === 'open' &&
			runs.length === 0
		const readySummary = status === 'ready' ? summary : null

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Activity"
					description="Failures and recent runs across jobs, packages, apps, and other surfaces — with the logs you need to diagnose them."
					currentHref={currentHref}
				/>
				<figure
					mix={css({
						display: 'grid',
						gap: spacing.sm,
						justifyItems: 'start',
						margin: 0,
						maxWidth: '46rem',
					})}
				>
					<blockquote
						mix={css({
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
							lineHeight: 1.5,
						})}
					>
						{activityErrorReviewPrompt}
					</blockquote>
					<CopyTextButton
						value={activityErrorReviewPrompt}
						idleLabel="Copy prompt"
						variant="ghost"
						size="sm"
					/>
				</figure>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading activity...
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}

				{readySummary ? (
					<>
						<div
							mix={css({
								display: 'grid',
								gap: spacing.md,
								gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
							})}
						>
							{[
								{ label: 'Runs (7 days)', value: String(readySummary.total) },
								{ label: 'Open errors', value: String(readySummary.errors) },
								{
									label: 'Ignored / resolved',
									value: String(readySummary.ignored + readySummary.resolved),
								},
								{ label: 'Running now', value: String(readySummary.running) },
							].map((item) => (
								<div
									key={item.label}
									mix={css({
										display: 'grid',
										gap: spacing.xs,
										padding: spacing.md,
										border: `1px solid ${colors.border}`,
										borderRadius: radius.md,
										backgroundColor: colors.surface,
									})}
								>
									<span
										mix={css({
											color: colors.textMuted,
											fontSize: typography.fontSize.sm,
										})}
									>
										{item.label}
									</span>
									<strong
										mix={css({
											fontSize: typography.fontSize.xl,
											fontWeight: typography.fontWeight.semibold,
											color:
												item.label === 'Open errors' && readySummary.errors > 0
													? colors.error
													: colors.text,
										})}
									>
										{item.value}
									</strong>
								</div>
							))}
						</div>

						<p
							mix={css({
								margin: 0,
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
							})}
						>
							Successful ad-hoc execute runs are not recorded (only failures
							are). Run records are kept for about {retentionDays} days. The
							default view shows open errors; ignored and resolved runs stay
							hidden until you change the triage filter.
						</p>

						{showRunNotFound ? (
							<AccountManagementMessage tone="error">
								This run does not exist for this account, or it has aged out of
								the retention window.
							</AccountManagementMessage>
						) : null}

						<RecordTable
							mode="expand"
							ariaLabel="Activity runs"
							selectedId={selection.selectedId}
							onNavigate={() => setMessage(null)}
							emptyLabel={
								emptyBecauseErrors
									? 'No failures in the last 7 days. That is good news — when something breaks, it will show up here with its logs.'
									: 'No runs match the current filters.'
							}
							toolbar={
								<>
									<RecordTableSelect
										label="Status filter"
										value={statusFilter}
										onChange={(value) => {
											if (
												value !== 'error' &&
												value !== 'all' &&
												value !== 'running'
											) {
												return
											}
											updateFilters({ status: value })
										}}
									>
										{statusFilterOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</RecordTableSelect>
									<RecordTableSelect
										label="Surface filter"
										value={surfaceFilter}
										onChange={(rawValue) => {
											const value = rawValue as AccountActivitySurfaceFilter
											if (
												!surfaceFilterOptions.some(
													(option) => option.value === value,
												)
											) {
												return
											}
											updateFilters({ surface: value })
										}}
									>
										{surfaceFilterOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</RecordTableSelect>
									<RecordTableSelect
										label="Triage filter"
										value={triageFilter}
										onChange={(rawValue) => {
											const value = rawValue as AccountActivityTriageFilter
											if (
												!triageFilterOptions.some(
													(option) => option.value === value,
												)
											) {
												return
											}
											updateFilters({ triage: value })
										}}
									>
										{triageFilterOptions.map((option) => (
											<option key={option.value} value={option.value}>
												{option.label}
											</option>
										))}
									</RecordTableSelect>
								</>
							}
							columns={[
								{ key: 'name', label: 'Run', primary: true },
								{ key: 'surface', label: 'Surface', drop: 3 },
								{ key: 'status', label: 'Status' },
								{ key: 'error', label: 'Error', drop: 1 },
								{ key: 'started', label: 'Started', drop: 2 },
								{ key: 'duration', label: 'Duration', align: 'end' },
							]}
							rows={runs.map((item) => ({
								id: item.id,
								href: activityRoute.buildDetailHref(item.id, filterSearch),
								cells: {
									name: (
										<span mix={clampedCellCss}>{runDisplayName(item)}</span>
									),
									surface: surfaceLabel(item.surface),
									status: (
										<span mix={css({ color: statusColor(item.status) })}>
											{statusLabel(item.status)}
										</span>
									),
									error: item.errorMessage ? (
										<span mix={[clampedCellCss, css({ color: colors.error })]}>
											{item.errorMessage}
										</span>
									) : null,
									started: (
										<span mix={css(recordStampCss)}>
											{formatTimestamp(item.startedAt)}
										</span>
									),
									duration: (
										<span mix={css(recordStampCss)}>
											{formatDurationMs(item.durationMs)}
										</span>
									),
								},
							}))}
							footer={
								nextCursor ? (
									<button
										type="button"
										disabled={loadingMore}
										mix={[
											on('click', () => void loadMoreRuns()),
											css({ ...secondaryButtonCss, width: '100%' }),
										]}
									>
										{loadingMore ? 'Loading more…' : 'Load more'}
									</button>
								) : null
							}
							record={
								detail ? (
									<section
										mix={css({
											...recordBodyCss,
											overflowWrap: 'anywhere',
											'& > *': { minWidth: 0 },
										})}
									>
										<div mix={css({ display: 'grid', gap: spacing.xs })}>
											<h2 mix={css(cardTitleCss)}>{runDisplayName(detail)}</h2>
											<p mix={css(descriptionCss)}>
												{surfaceLabel(detail.surface)} run with{' '}
												{detail.logCount === 1
													? '1 captured log line'
													: `${detail.logCount} captured log lines`}
												.
											</p>
										</div>

										<MetadataGrid
											items={[
												{
													label: 'Status',
													value: (
														<span
															mix={css({ color: statusColor(detail.status) })}
														>
															{statusLabel(detail.status)}
														</span>
													),
												},
												{
													label: 'Triage',
													value: triageLabel(detail),
												},
												{
													label: 'Triage note',
													value: detail.triageNote ?? '—',
												},
												{
													label: 'Triaged at',
													value: <TimestampValue value={detail.triagedAt} />,
												},
												{
													label: 'Triaged by',
													value: detail.triagedBy ?? '—',
												},
												{
													label: 'Surface',
													value: surfaceLabel(detail.surface),
												},
												{
													label: 'Started',
													value: <TimestampValue value={detail.startedAt} />,
												},
												{
													label: 'Finished',
													value: <TimestampValue value={detail.finishedAt} />,
												},
												{
													label: 'Duration',
													value: formatDurationMs(detail.durationMs),
												},
												{
													label: 'Package id',
													value: detail.packageId ? (
														<IdValue
															value={detail.packageId}
															label="package id"
														/>
													) : (
														'—'
													),
												},
												{
													label: 'Job id',
													value: detail.jobId ? (
														<IdValue value={detail.jobId} label="job id" />
													) : (
														'—'
													),
												},
												{
													label: 'Workflow id',
													value: detail.workflowId ? (
														<IdValue
															value={detail.workflowId}
															label="workflow id"
														/>
													) : (
														'—'
													),
												},
												{
													label: 'Storage id',
													value: detail.storageId ? (
														<IdValue
															value={detail.storageId}
															label="storage id"
														/>
													) : (
														'—'
													),
												},
												{
													label: 'Source id',
													value: detail.sourceId ? (
														<IdValue
															value={detail.sourceId}
															label="source id"
														/>
													) : (
														'—'
													),
												},
												{
													label: 'Published commit',
													value: detail.publishedCommit ? (
														<IdValue
															value={detail.publishedCommit}
															label="published commit"
														/>
													) : (
														'—'
													),
												},
												{
													label: 'Run id',
													value: <IdValue value={detail.id} label="run id" />,
												},
											]}
										/>

										{detail.errorMessage ? (
											<AccountManagementMessage tone="error">
												{detail.errorName
													? `${detail.errorName}: ${detail.errorMessage}`
													: detail.errorMessage}
											</AccountManagementMessage>
										) : null}

										<div mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Logs</span>
											{detail.logs.length === 0 ? (
												<p mix={css({ margin: 0, color: colors.textMuted })}>
													No log lines were captured for this run.
												</p>
											) : (
												<pre
													mix={css({
														margin: 0,
														padding: spacing.md,
														borderRadius: radius.md,
														border: `1px solid ${colors.border}`,
														backgroundColor: colors.background,
														color: colors.text,
														fontFamily:
															'ui-monospace, SFMono-Regular, Menlo, monospace',
														fontSize: typography.fontSize.sm,
														overflowX: 'auto',
														whiteSpace: 'pre-wrap',
														overflowWrap: 'anywhere',
														display: 'grid',
														gap: spacing.xs,
													})}
												>
													{detail.logs.map((entry) => (
														<span
															key={`${entry.sequence}-${entry.level}`}
															mix={css({
																display: 'grid',
																gridTemplateColumns: '4.5rem minmax(0, 1fr)',
																gap: spacing.sm,
																color: logLevelColor(entry.level),
																[accountManagementNarrowMq]: {
																	gridTemplateColumns: 'minmax(0, 1fr)',
																	gap: spacing.xs,
																},
															})}
														>
															<span
																mix={css({
																	color: colors.textMuted,
																	textTransform: 'uppercase',
																	fontSize: typography.fontSize.xs,
																	lineHeight: '1.5rem',
																})}
															>
																{entry.level}
															</span>
															<span>{entry.message}</span>
														</span>
													))}
												</pre>
											)}
										</div>

										{Object.keys(detail.metadata).length > 0 ? (
											<div mix={css(fieldCss)}>
												<span mix={css(fieldLabelCss)}>Metadata</span>
												<div
													mix={css({
														minWidth: 0,
														'& pre': {
															margin: 0,
															padding: spacing.sm,
															borderRadius: radius.md,
															border: `1px solid ${colors.border}`,
															fontFamily:
																'ui-monospace, SFMono-Regular, Menlo, monospace',
															fontSize: typography.fontSize.sm,
															overflowX: 'auto',
															whiteSpace: 'pre-wrap',
															overflowWrap: 'anywhere',
														},
													})}
												>
													{renderHighlightedCode(
														JSON.stringify(detail.metadata, null, 2),
														'json',
													)}
												</div>
											</div>
										) : null}
									</section>
								) : waitingForDetail ? (
									<p
										mix={css({
											...recordBodyCss,
											margin: 0,
											color: colors.textMuted,
										})}
									>
										Loading run details…
									</p>
								) : null
							}
						/>
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
