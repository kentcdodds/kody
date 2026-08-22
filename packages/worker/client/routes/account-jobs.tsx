import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
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
	filterAccountJobs,
	readJobsSearchFilter,
	readJobsViewFilter,
	type AccountJobsViewFilter,
} from '#client/routes/account-jobs-filter.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import {
	RecordChips,
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordBodyCss,
	recordCellClamp,
} from '#client/routes/record-table.tsx'
import {
	type AccountJobDetail,
	type AccountJobListItem,
	type AccountJobsLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { renderHighlightedCode } from '#client/syntax-highlight.tsx'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

const clampedCellCss = css(recordCellClamp(28))

type MessageTone = 'info' | 'error'

const accountJobsApiPath = '/account/jobs.json'
const jobsRoute = createListDetailRoute('/account/jobs')

const viewFilterOptions: Array<{
	value: AccountJobsViewFilter
	label: string
}> = [
	{ value: 'active', label: 'Active' },
	{ value: 'history', label: 'History' },
	{ value: 'all', label: 'All' },
]

/**
 * Latch key includes the selected job id because detail fields (recent runs,
 * params, errors) are loaded with `?selected=`. The client-side `q` / `view`
 * filters are omitted so search typing and filter toggles do not refetch.
 */
function getDataLatchKey(href: string) {
	const selectedId = jobsRoute.getSelection(href).selectedId
	return selectedId
		? `/account/jobs?selected=${encodeURIComponent(selectedId)}`
		: '/account/jobs'
}

function emptyJobsMessage(input: {
	totalCount: number
	filteredCount: number
	view: AccountJobsViewFilter
	search: string
}) {
	if (input.totalCount === 0) return 'No scheduled jobs yet.'
	if (input.filteredCount > 0) return null
	if (input.search || input.view === 'all') {
		return 'No jobs match the current filters.'
	}
	if (input.view === 'history') {
		return 'No inactive or past jobs.'
	}
	return 'No active or upcoming jobs. Switch to History or All to see other jobs.'
}

function buildJobsApiRequestUrl(href: string) {
	const requestUrl = new URL(accountJobsApiPath, 'http://localhost')
	const selectedJobId = jobsRoute.getSelection(href).selectedId
	if (selectedJobId) {
		requestUrl.searchParams.set('selected', selectedJobId)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountJobsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildJobsApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountJobsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load scheduled jobs.')
	}
	return { accountJobs: payload }
}

function packageLabel(
	job: Pick<AccountJobListItem, 'ownership' | 'packageName'>,
) {
	if (job.ownership === 'package') {
		return job.packageName ?? 'Package'
	}
	return '—'
}

function packageValue(
	job: Pick<AccountJobListItem, 'ownership' | 'packageId' | 'packageName'>,
) {
	if (job.ownership !== 'package') return '—'
	if (job.packageId && job.packageName) {
		return (
			<a
				href={routes.accountPackageDetail.href({
					packageId: job.packageId,
				})}
				mix={css(primaryLinkCss)}
			>
				{job.packageName}
			</a>
		)
	}
	return job.packageName ?? 'Package'
}

function statusLabel(
	job: Pick<
		AccountJobListItem,
		'enabled' | 'killSwitchEnabled' | 'dueNow' | 'lastRunStatus' | 'expired'
	>,
) {
	if (job.killSwitchEnabled) return 'Kill switch on'
	if (job.expired) return 'Expired'
	if (!job.enabled) return 'Disabled'
	if (job.dueNow) return 'Due now'
	if (job.lastRunStatus === 'error') return 'Last run failed'
	if (job.lastRunStatus === 'success') return 'Last run ok'
	return 'Scheduled'
}

function statusColor(
	job: Pick<
		AccountJobListItem,
		'enabled' | 'killSwitchEnabled' | 'dueNow' | 'lastRunStatus' | 'expired'
	>,
) {
	if (job.killSwitchEnabled) return colors.error
	if (job.expired) return colors.textMuted
	if (!job.enabled) return colors.textMuted
	if (job.dueNow) return colors.primary
	if (job.lastRunStatus === 'error') return colors.error
	if (job.lastRunStatus === 'success') return colors.primary
	return colors.textMuted
}

function formatDurationMs(durationMs: number | null) {
	if (durationMs == null) return '—'
	if (durationMs < 1000) return `${durationMs} ms`
	return `${(durationMs / 1000).toFixed(1)} s`
}

function tryConsumeAccountJobsLoaderData(handle: Handle, href: string) {
	return tryConsumeRouteLoaderData(handle, 'accountJobs', href)
}

export function AccountJobsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionState: 'idle' | 'busy' = 'idle'
	let jobs: Array<AccountJobListItem> = []
	let selectedJob: AccountJobDetail | null = null
	let retention: AccountJobsLoaderData['retention'] = {
		successOnceDays: 14,
		failedOrNeverRanOnceDays: 60,
		disabledRecurringDays: 90,
		defaults: {
			successOnce: 14,
			failedOrNeverRanOnce: 60,
			disabledRecurring: 90,
		},
	}
	let retentionDraft = {
		successOnceDays: '14',
		failedOrNeverRanOnceDays: '60',
		disabledRecurringDays: '90',
	}
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	const loadLatch = createRouteLoadLatch()
	const deleteJobCheck = createDoubleCheck(handle)

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function getCurrentHref() {
		return readCurrentRouterHref(handle)
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function buildHrefWithUpdatedFilters(next: {
		search?: string
		view?: AccountJobsViewFilter
	}) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		const search = next.search ?? nextUrl.searchParams.get('q')?.trim() ?? ''
		const view = next.view ?? readJobsViewFilter(nextUrl.href)
		if (search) nextUrl.searchParams.set('q', search)
		else nextUrl.searchParams.delete('q')
		if (view === 'active') nextUrl.searchParams.delete('view')
		else nextUrl.searchParams.set('view', view)
		return `${nextUrl.pathname}${nextUrl.search}`
	}

	function setMessage(nextMessage: string | null, tone: MessageTone = 'info') {
		message = nextMessage
		messageTone = tone
	}

	function applyRetention(next: AccountJobsLoaderData['retention']) {
		retention = next
		retentionDraft = {
			successOnceDays: String(next.successOnceDays),
			failedOrNeverRanOnceDays: String(next.failedOrNeverRanOnceDays),
			disabledRecurringDays: String(next.disabledRecurringDays),
		}
	}

	function applyPayload(payload: AccountJobsLoaderData) {
		jobs = payload.jobs
		selectedJob = payload.selectedJob
		applyRetention(payload.retention)
		deleteJobCheck.reset()
	}

	async function loadJobs(signal: AbortSignal) {
		const href = getCurrentHref()
		const latchKey = getDataLatchKey(href)
		try {
			const response = await fetch(buildJobsApiRequestUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountJobsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load scheduled jobs.')
			}
			if (getDataLatchKey(getCurrentHref()) !== latchKey) return
			applyPayload(payload)
			if (messageTone === 'error') setMessage(null)
			status = 'ready'
			loadLatch.markLoaded(latchKey)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to load scheduled jobs.',
				'error',
			)
			loadLatch.markFailed(latchKey)
			handle.update()
		}
	}

	async function postAction(input: {
		body: Record<string, unknown>
		successMessage: (
			payload: AccountJobsLoaderData & {
				runNow?: { ok: boolean; error: string | null; deletedAfterRun: boolean }
			},
		) => string | null
		failureMessage: string
		afterSuccess?: (
			payload: AccountJobsLoaderData & {
				runNow?: { ok: boolean; error: string | null; deletedAfterRun: boolean }
			},
		) => void
	}) {
		if (actionState !== 'idle') return
		actionState = 'busy'
		setMessage(null)
		handle.update()
		try {
			const response = await fetch(accountJobsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(input.body),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AccountJobsLoaderData & {
					error?: string
					ok?: boolean
					runNow?: {
						ok: boolean
						error: string | null
						deletedAfterRun: boolean
					}
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || input.failureMessage)
			}
			applyPayload(payload)
			actionState = 'idle'
			setMessage(input.successMessage(payload))
			input.afterSuccess?.(payload)
			handle.update()
		} catch (error) {
			actionState = 'idle'
			setMessage(
				error instanceof Error ? error.message : input.failureMessage,
				'error',
			)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!jobsRoute.isRoutePath(href)) return false
		const routeData = tryConsumeAccountJobsLoaderData(handle, href)
		if (!routeData) return false
		applyPayload(routeData)
		status = 'ready'
		loadLatch.markLoaded(getDataLatchKey(href))
		return true
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
			handle.queueTask(loadJobs)
		}
		const isMutating = actionState !== 'idle'
		const selection = jobsRoute.getSelection(currentHref)
		const search = readJobsSearchFilter(currentHref)
		const view = readJobsViewFilter(currentHref)
		const filteredJobs = filterAccountJobs(jobs, {
			view,
			search,
		})
		const listEmptyMessage = emptyJobsMessage({
			totalCount: jobs.length,
			filteredCount: filteredJobs.length,
			view,
			search,
		})
		const detail =
			selectedJob && selectedJob.id === selection.selectedId
				? selectedJob
				: null
		const listMatch =
			jobs.find((item) => item.id === selection.selectedId) ?? null
		const waitingForDetail =
			selection.selectedId != null &&
			!detail &&
			(needsLoad || listMatch != null || status === 'loading')
		const showJobNotFound =
			selection.selectedId != null &&
			!detail &&
			!waitingForDetail &&
			status === 'ready'
		const isPackageOwned = detail?.ownership === 'package'
		const isNotPackageOwned = detail != null && !isPackageOwned

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Jobs"
					description="Inspect scheduled package jobs, toggle kill switch or Preserve, and run jobs now. Completed one-off jobs are cleaned up automatically after your retention windows; longer retention uses more scheduled job slots and storage."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading jobs...
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={
							status === 'error' || messageTone === 'error' ? 'error' : 'info'
						}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				{status === 'ready' ? (
					<section
						mix={css({
							...cardCss,
							marginBottom: spacing.lg,
							display: 'grid',
							gap: spacing.md,
						})}
					>
						<div mix={css({ display: 'grid', gap: spacing.xs })}>
							<h2 mix={css(cardTitleCss)}>Job retention</h2>
							<p mix={css(descriptionCss)}>
								Platform defaults clean up successful one-off jobs after{' '}
								{retention.defaults.successOnce} days, failed or never-ran
								one-offs after {retention.defaults.failedOrNeverRanOnce} days,
								and disabled recurring jobs after{' '}
								{retention.defaults.disabledRecurring} days. Longer windows keep
								more jobs counting toward scheduled job slots and storage bytes.
								Keep forever only with Preserve on a job — retention cannot be
								unbounded.
							</p>
						</div>
						<div
							mix={css({
								display: 'grid',
								gap: spacing.md,
								gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
							})}
						>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Successful one-off (days)</span>
								<input
									data-field-ring
									type="number"
									min={1}
									max={365}
									value={retentionDraft.successOnceDays}
									disabled={isMutating}
									mix={[
										on('input', (event) => {
											retentionDraft = {
												...retentionDraft,
												successOnceDays: (
													event.currentTarget as HTMLInputElement
												).value,
											}
											handle.update()
										}),
										css(accountInputCss),
									]}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>
									Failed / never-ran one-off (days)
								</span>
								<input
									data-field-ring
									type="number"
									min={1}
									max={365}
									value={retentionDraft.failedOrNeverRanOnceDays}
									disabled={isMutating}
									mix={[
										on('input', (event) => {
											retentionDraft = {
												...retentionDraft,
												failedOrNeverRanOnceDays: (
													event.currentTarget as HTMLInputElement
												).value,
											}
											handle.update()
										}),
										css(accountInputCss),
									]}
								/>
							</label>
							<label mix={css(fieldCss)}>
								<span mix={css(fieldLabelCss)}>Disabled recurring (days)</span>
								<input
									data-field-ring
									type="number"
									min={1}
									max={365}
									value={retentionDraft.disabledRecurringDays}
									disabled={isMutating}
									mix={[
										on('input', (event) => {
											retentionDraft = {
												...retentionDraft,
												disabledRecurringDays: (
													event.currentTarget as HTMLInputElement
												).value,
											}
											handle.update()
										}),
										css(accountInputCss),
									]}
								/>
							</label>
						</div>
						<div>
							<button
								type="button"
								disabled={isMutating}
								mix={[
									on('click', () =>
										postAction({
											body: {
												action: 'update_retention',
												successOnceDays: Number(retentionDraft.successOnceDays),
												failedOrNeverRanOnceDays: Number(
													retentionDraft.failedOrNeverRanOnceDays,
												),
												disabledRecurringDays: Number(
													retentionDraft.disabledRecurringDays,
												),
												selectedJobId: selection.selectedId,
											},
											successMessage: () =>
												'Updated job retention preferences.',
											failureMessage:
												'Unable to update job retention preferences.',
										}),
									),
									css(secondaryButtonCss),
								]}
							>
								Save retention
							</button>
						</div>
					</section>
				) : null}

				{status === 'ready' ? (
					<RecordTable
						mode="expand"
						ariaLabel="Scheduled jobs"
						selectedId={selection.selectedId}
						onNavigate={() => {
							deleteJobCheck.reset()
							setMessage(null)
						}}
						countLabel={`${filteredJobs.length} of ${jobs.length} shown`}
						emptyLabel={
							listEmptyMessage ?? 'No jobs match the current filters.'
						}
						toolbar={
							<>
								<RecordTableSearch
									label="Search jobs"
									placeholder="Search jobs"
									value={search}
									onInput={(value) => {
										replaceLocation(
											buildHrefWithUpdatedFilters({ search: value }),
										)
									}}
								/>
								<RecordTableSelect
									label="Jobs view filter"
									value={view}
									onChange={(value) => {
										if (
											value !== 'active' &&
											value !== 'history' &&
											value !== 'all'
										) {
											return
										}
										replaceLocation(
											buildHrefWithUpdatedFilters({ view: value }),
										)
									}}
								>
									{viewFilterOptions.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</RecordTableSelect>
							</>
						}
						columns={[
							{ key: 'name', label: 'Job', primary: true },
							{ key: 'status', label: 'Status' },
							{ key: 'schedule', label: 'Schedule', drop: 1 },
							{ key: 'package', label: 'Package', drop: 2 },
							{ key: 'flags', label: 'Flags', drop: 3 },
							{ key: 'runs', label: 'Runs', align: 'end' },
						]}
						rows={filteredJobs.map((item) => ({
							id: item.id,
							// A save, toggle, or delete is in flight; the expanded
							// editor owns the selection until it settles.
							href: isMutating
								? undefined
								: jobsRoute.buildDetailHref(item.id, getCurrentSearch()),
							cells: {
								name: <span mix={clampedCellCss}>{item.name}</span>,
								status: (
									<span mix={css({ color: statusColor(item) })}>
										{statusLabel(item)}
									</span>
								),
								schedule: (
									<span mix={clampedCellCss}>{item.scheduleSummary}</span>
								),
								package: <span mix={clampedCellCss}>{packageLabel(item)}</span>,
								flags: (
									<RecordChips
										items={[
											...(item.preserved ? ['Preserved'] : []),
											...(item.expired ? ['Expired'] : []),
										]}
										empty="—"
									/>
								),
								runs: String(item.runCount),
							},
						}))}
						record={
							detail ? (
								<section mix={css(recordBodyCss)}>
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<h2 mix={css(cardTitleCss)}>{detail.name}</h2>
										<p mix={css(descriptionCss)}>
											{isPackageOwned
												? 'Package-owned job. Schedule and name are owned by package publish; kill switch and run-now are available here. Use the kill switch to stop it.'
												: 'Scheduled job. You can enable or disable it, Preserve it from auto-cleanup, or delete it.'}
										</p>
									</div>

									<MetadataGrid
										items={[
											{
												label: 'Package',
												value: packageValue(detail),
											},
											{
												label: 'Preserve',
												value: detail.preserved
													? 'On (never auto-deleted)'
													: 'Off',
											},
											{
												label: 'Expires',
												value: detail.expiresAt ? (
													<>
														{detail.expired ? 'Expired ' : ''}
														<TimestampValue value={detail.expiresAt} />
													</>
												) : (
													'Never'
												),
											},
											{
												label: 'Status',
												value: (
													<span mix={css({ color: statusColor(detail) })}>
														{statusLabel(detail)}
													</span>
												),
											},
											{
												label: 'Schedule',
												value: detail.scheduleSummary,
											},
											{
												label: 'Timezone',
												value: detail.timezone,
											},
											{
												label: 'Next run',
												value: <TimestampValue value={detail.nextRunAt} />,
											},
											{
												label: 'Last run',
												value: <TimestampValue value={detail.lastRunAt} />,
											},
											{
												label: 'Last duration',
												value: formatDurationMs(detail.lastDurationMs),
											},
											{
												label: 'Runs',
												value: `${detail.runCount} total · ${detail.successCount} ok · ${detail.errorCount} error`,
											},
											{
												label: 'Storage id',
												value: (
													<IdValue
														value={detail.storageId}
														label="storage id"
													/>
												),
											},
											{
												label: 'Source id',
												value: (
													<IdValue value={detail.sourceId} label="source id" />
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
												label: 'Updated',
												value: <TimestampValue value={detail.updatedAt} />,
											},
										]}
									/>

									{detail.lastRunError ? (
										<AccountManagementMessage tone="error">
											{detail.lastRunError}
										</AccountManagementMessage>
									) : null}

									{isPackageOwned ? (
										<p mix={css(descriptionCss)}>
											To change this job&apos;s schedule or name, update the
											package job declaration and publish the package again.
										</p>
									) : null}

									<div mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Recent runs</span>
										{detail.recentRuns.length === 0 ? (
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												No runs recorded yet.
											</p>
										) : (
											<div
												mix={css({
													overflowX: 'auto',
													border: `1px solid ${colors.border}`,
													borderRadius: radius.md,
												})}
											>
												<table
													mix={css({
														width: '100%',
														borderCollapse: 'collapse',
														fontSize: typography.fontSize.sm,
													})}
												>
													<thead>
														<tr>
															{[
																'Started',
																'Finished',
																'Status',
																'Duration',
																'Error',
																'',
															].map((heading) => (
																<th
																	key={heading || 'logs'}
																	mix={css({
																		textAlign: 'left',
																		padding: spacing.sm,
																		borderBottom: `1px solid ${colors.border}`,
																		color: colors.textMuted,
																		fontWeight: typography.fontWeight.medium,
																	})}
																>
																	{heading}
																</th>
															))}
														</tr>
													</thead>
													<tbody>
														{detail.recentRuns.map((run) => (
															<tr key={run.id}>
																<td
																	mix={css({
																		padding: spacing.sm,
																		borderBottom: `1px solid ${colors.border}`,
																	})}
																>
																	{formatTimestamp(run.startedAt)}
																</td>
																<td
																	mix={css({
																		padding: spacing.sm,
																		borderBottom: `1px solid ${colors.border}`,
																	})}
																>
																	{formatTimestamp(run.finishedAt)}
																</td>
																<td
																	mix={css({
																		padding: spacing.sm,
																		borderBottom: `1px solid ${colors.border}`,
																		color:
																			run.status === 'error'
																				? colors.error
																				: run.status === 'running'
																					? colors.textMuted
																					: colors.primary,
																	})}
																>
																	{run.status}
																</td>
																<td
																	mix={css({
																		padding: spacing.sm,
																		borderBottom: `1px solid ${colors.border}`,
																	})}
																>
																	{formatDurationMs(run.durationMs)}
																</td>
																<td
																	mix={css({
																		padding: spacing.sm,
																		borderBottom: `1px solid ${colors.border}`,
																		color: colors.textMuted,
																		maxWidth: '16rem',
																		overflowWrap: 'anywhere',
																	})}
																>
																	{run.error ?? '—'}
																</td>
																<td
																	mix={css({
																		padding: spacing.sm,
																		borderBottom: `1px solid ${colors.border}`,
																	})}
																>
																	<a
																		href={routes.accountActivityDetail.href({
																			runId: run.id,
																		})}
																		mix={css(primaryLinkCss)}
																	>
																		Logs
																	</a>
																</td>
															</tr>
														))}
													</tbody>
												</table>
											</div>
										)}
									</div>

									{detail.params ? (
										<div mix={css(fieldCss)}>
											<span mix={css(fieldLabelCss)}>Params</span>
											<div
												mix={css({
													'& pre': {
														margin: 0,
														padding: spacing.sm,
														borderRadius: radius.md,
														border: `1px solid ${colors.border}`,
														fontFamily: 'monospace',
														fontSize: typography.fontSize.sm,
														overflowX: 'auto',
														whiteSpace: 'pre-wrap',
													},
												})}
											>
												{renderHighlightedCode(
													JSON.stringify(detail.params, null, 2),
													'json',
												)}
											</div>
										</div>
									) : null}

									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											flexWrap: 'wrap',
										})}
									>
										<button
											type="button"
											disabled={isMutating}
											mix={[
												on('click', () =>
													postAction({
														body: { action: 'run_now', id: detail.id },
														successMessage: (payload) => {
															if (payload.runNow?.deletedAfterRun) {
																return payload.runNow.ok
																	? 'Ran one-off job and deleted it.'
																	: `Ran one-off job (failed) and deleted it${
																			payload.runNow.error
																				? `: ${payload.runNow.error}`
																				: '.'
																		}`
															}
															if (payload.runNow && !payload.runNow.ok) {
																return `Run finished with an error${
																	payload.runNow.error
																		? `: ${payload.runNow.error}`
																		: '.'
																}`
															}
															if (
																detail.schedule.type === 'once' &&
																payload.runNow?.ok
															) {
																return detail.preserved
																	? 'Job run finished. Preserved — will not be auto-deleted.'
																	: `Job run finished. Kept for ${retention.successOnceDays} days · Preserve to keep forever.`
															}
															return 'Job run requested.'
														},
														failureMessage: 'Unable to run job now.',
														afterSuccess: (payload) => {
															if (payload.runNow?.deletedAfterRun) {
																navigate(
																	jobsRoute.buildListHref(getCurrentSearch()),
																)
															}
														},
													}),
												),
												css(primaryButtonCss),
											]}
										>
											Run now
										</button>
										<button
											type="button"
											disabled={isMutating}
											mix={[
												on('click', () =>
													postAction({
														body: {
															action: 'set_kill_switch',
															id: detail.id,
															killSwitchEnabled: !detail.killSwitchEnabled,
														},
														successMessage: () =>
															detail.killSwitchEnabled
																? 'Cleared kill switch.'
																: 'Enabled kill switch.',
														failureMessage: 'Unable to update kill switch.',
													}),
												),
												css(secondaryButtonCss),
											]}
										>
											{detail.killSwitchEnabled
												? 'Clear kill switch'
												: 'Enable kill switch'}
										</button>
										{isNotPackageOwned ? (
											<button
												type="button"
												disabled={isMutating}
												mix={[
													on('click', () =>
														postAction({
															body: {
																action: 'set_preserved',
																id: detail.id,
																preserved: !detail.preserved,
															},
															successMessage: () =>
																detail.preserved
																	? 'Cleared Preserve. This job can age out under retention.'
																	: 'Preserved. This job will not be auto-deleted.',
															failureMessage: 'Unable to update Preserve.',
														}),
													),
													css(secondaryButtonCss),
												]}
											>
												{detail.preserved ? 'Clear Preserve' : 'Preserve'}
											</button>
										) : null}
										{isNotPackageOwned ? (
											<button
												type="button"
												disabled={isMutating}
												mix={[
													on('click', () =>
														postAction({
															body: {
																action: 'set_enabled',
																id: detail.id,
																enabled: !detail.enabled,
															},
															successMessage: () =>
																detail.enabled
																	? 'Disabled job.'
																	: 'Enabled job.',
															failureMessage: 'Unable to update job.',
														}),
													),
													css(secondaryButtonCss),
												]}
											>
												{detail.enabled ? 'Disable' : 'Enable'}
											</button>
										) : null}
										{isNotPackageOwned ? (
											<button
												type="button"
												disabled={isMutating}
												mix={[
													...deleteJobCheck.getButtonMix({
														on: {
															click: () =>
																void postAction({
																	body: { action: 'delete', id: detail.id },
																	successMessage: () => 'Deleted job.',
																	failureMessage: 'Unable to delete job.',
																	afterSuccess: () => {
																		navigate(
																			jobsRoute.buildListHref(
																				getCurrentSearch(),
																			),
																		)
																	},
																}),
														},
														resetAfterAction: false,
													}),
													css(dangerButtonCss),
												]}
											>
												{deleteJobCheck.doubleCheck
													? 'Confirm delete'
													: 'Delete'}
											</button>
										) : null}
									</div>
								</section>
							) : waitingForDetail ? (
								<div mix={css({ ...recordBodyCss, gap: spacing.sm })}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
										})}
									>
										{listMatch?.name ?? 'Loading job'}
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										Loading job details...
									</p>
								</div>
							) : showJobNotFound ? (
								<div mix={css({ ...recordBodyCss, gap: spacing.sm })}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
										})}
									>
										Job not found
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										This job does not exist for this account or is unavailable.
									</p>
								</div>
							) : null
						}
					/>
				) : null}
			</AccountManagementShell>
		)
	}
}
