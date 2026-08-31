import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { replaceLocation } from '#client/replace-location.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import { renderActivityRunDetail } from '#client/routes/account-activity-detail.tsx'
import {
	activityErrorReviewPrompt,
	activityRoute,
	buildActivityApiRequestUrl,
	buildActivitySearch,
	formatDurationMs,
	getDataLatchKey,
	readStatusFilter,
	readSurfaceFilter,
	readTriageFilter,
	runDisplayName,
	statusColor,
	statusLabel,
	statusFilterOptions,
	surfaceFilterOptions,
	surfaceLabel,
	triageFilterOptions,
} from '#client/routes/account-activity-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
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
} from '#universal/loader-data.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'

const clampedCellCss = css(recordCellClamp(30))

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
									renderActivityRunDetail(detail)
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
