import { type Handle, css } from 'remix/component'
import { navigate, readCurrentRouterHref } from '#client/client-router.tsx'
import { replaceLocation } from '#client/replace-location.ts'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
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
	fetchAccountJobsPayload,
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
import { colors } from '#universal/styles/tokens.ts'

const clampedCellCss = css(recordCellClamp(28))

type MessageTone = 'info' | 'error'

export function AccountJobsRoute(handle: Handle) {
	let actionState: 'idle' | 'busy' = 'idle'
	let username = ''
	let jobs: Array<AccountJobListItem> = []
	let selectedJob: AccountJobDetail | null = null
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	/** Payload last applied to the closure state above. */
	let appliedPayload: AccountJobsLoaderData | null = null
	let appliedError: Error | null = null
	const jobsData = createRouteData({
		key: 'accountJobs',
		locationKey: getDataLatchKey,
		async load(href, signal) {
			const payload = await fetchAccountJobsPayload(href, signal)
			return payload ?? routeDataRedirect('/login')
		},
	})

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

	function applyPayload(payload: AccountJobsLoaderData) {
		username = payload.username
		jobs = payload.jobs
		selectedJob = payload.selectedJob
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

	return () => {
		const currentHref = getCurrentHref()
		const snapshot = jobsData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			applyPayload(snapshot.data)
			if (messageTone === 'error') setMessage(null)
		}
		if (snapshot.error && snapshot.error !== appliedError) {
			appliedError = snapshot.error
			setMessage(snapshot.error.message, 'error')
		}
		const pending = snapshot.kind === 'pending'
		const status: AccountStatus =
			snapshot.kind === 'error'
				? 'error'
				: pending && appliedPayload === null
					? 'loading'
					: 'ready'
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
			(pending || listMatch != null || status === 'loading')
		const showJobNotFound =
			selection.selectedId != null &&
			!detail &&
			!waitingForDetail &&
			status === 'ready'

		return (
			<AccountManagementShell busy={pending && appliedPayload !== null}>
				<AccountPageHeader
					title="Jobs"
					description="Inspect scheduled package jobs, toggle the kill switch, and run jobs now. To change or remove a job, edit its package and publish."
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
					<RecordTable
						mode="expand"
						ariaLabel="Scheduled jobs"
						selectedId={selection.selectedId}
						recordLoading={waitingForDetail}
						onNavigate={() => {
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
							// A toggle or run is in flight; the expanded
							// editor owns the selection until it settles.
							href: isMutating
								? undefined
								: jobsRoute.buildDetailHref(
										item.id,
										getCurrentSearch(),
										getCurrentHref(),
									),
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
										items={item.expired ? ['Expired'] : []}
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
										currentHref: getCurrentHref(),
										detail,
										isMutating,
										postAction,
										navigateToList: () => {
											navigate(
												jobsRoute.buildListHref(
													getCurrentSearch(),
													getCurrentHref(),
												),
											)
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
