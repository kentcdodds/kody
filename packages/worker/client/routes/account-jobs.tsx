import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { createDoubleCheck } from '#client/double-check.ts'
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
	renderAccountJobDetail,
	renderJobDetailPlaceholder,
} from '#client/routes/account-jobs-detail.tsx'
import {
	type AccountJobsActionPayload,
	accountJobsApiPath,
	buildJobsApiRequestUrl,
	emptyJobsMessage,
	getDataLatchKey,
	jobsRoute,
	packageLabel,
	statusColor,
	statusLabel,
	viewFilterOptions,
} from '#client/routes/account-jobs-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	accountInputCss,
} from '#client/routes/account-management-components.tsx'
import {
	RecordChips,
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordCellClamp,
} from '#client/routes/record-table.tsx'
import {
	type AccountJobDetail,
	type AccountJobListItem,
	type AccountJobsLoaderData,
} from '#universal/loader-data.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'

const clampedCellCss = css(recordCellClamp(28))

type MessageTone = 'info' | 'error'

function tryConsumeAccountJobsLoaderData(handle: Handle, href: string) {
	return tryConsumeRouteLoaderData(handle, 'accountJobs', href)
}

export function AccountJobsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionState: 'idle' | 'busy' = 'idle'
	let username = ''
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

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

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
		username = payload.username
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
		successMessage: (payload: AccountJobsActionPayload) => string | null
		failureMessage: string
		afterSuccess?: (payload: AccountJobsActionPayload) => void
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
				AccountJobsActionPayload & {
					error?: string
					ok?: boolean
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

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Jobs"
					description="Inspect scheduled package jobs, toggle kill switch or Preserve, and run jobs now. Completed one-off jobs are cleaned up automatically after your retention windows; longer retention uses more scheduled job slots and storage."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>Loading jobs…</p>
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
						recordLoading={waitingForDetail}
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
							detail
								? renderAccountJobDetail({
										username,
										detail,
										isMutating,
										retention,
										deleteJobCheck,
										postAction,
										navigateToList: () => {
											navigate(jobsRoute.buildListHref(getCurrentSearch()))
										},
									})
								: waitingForDetail
									? renderJobDetailPlaceholder(
											listMatch?.name ?? 'Loading job',
											'Loading job details…',
										)
									: showJobNotFound
										? renderJobDetailPlaceholder(
												'Job not found',
												'This job does not exist for this account or is unavailable.',
											)
										: null
						}
					/>
				) : null}
			</AccountManagementShell>
		)
	}
}
