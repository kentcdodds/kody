import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
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
	filterAccountWorkflows,
	isActiveAccountWorkflow,
	readWorkflowsSearchFilter,
	readWorkflowsViewFilter,
	type AccountWorkflowsViewFilter,
} from '#client/routes/account-workflows-filter.ts'
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
} from '#client/routes/account-management-components.tsx'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
} from '#client/routes/record-table.tsx'
import {
	type AccountWorkflowDetail,
	type AccountWorkflowListItem,
	type AccountWorkflowRunStatus,
	type AccountWorkflowsLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	getDangerPillCss,
	getGhostButtonCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

const clampedCellCss = css(recordCellClamp(28))

type MessageTone = 'info' | 'error'

const accountWorkflowsApiPath = '/account/workflows.json'
const workflowsRoute = createListDetailRoute('/account/workflows')

const viewFilterOptions: Array<{
	value: AccountWorkflowsViewFilter
	label: string
}> = [
	{ value: 'active', label: 'Active' },
	{ value: 'history', label: 'History' },
	{ value: 'all', label: 'All' },
]

/**
 * Latch key includes the selected workflow id because detail is loaded with
 * `?selected=`. Client-side `q` / `view` filters are omitted so search typing
 * and filter toggles do not refetch.
 */
function getDataLatchKey(href: string) {
	const selectedId = workflowsRoute.getSelection(href).selectedId
	return selectedId
		? `/account/workflows?selected=${encodeURIComponent(selectedId)}`
		: '/account/workflows'
}

function emptyWorkflowsMessage(input: {
	totalCount: number
	filteredCount: number
	view: AccountWorkflowsViewFilter
	search: string
}) {
	if (input.totalCount === 0) return 'No workflow runs yet.'
	if (input.filteredCount > 0) return null
	if (input.search || input.view === 'all') {
		return 'No workflows match the current filters.'
	}
	if (input.view === 'history') {
		return 'No finished workflow runs.'
	}
	return 'No active workflow runs. Switch to History or All to see other runs.'
}

function buildWorkflowsApiRequestUrl(href: string) {
	const requestUrl = new URL(accountWorkflowsApiPath, 'http://localhost')
	const selectedWorkflowId = workflowsRoute.getSelection(href).selectedId
	if (selectedWorkflowId) {
		requestUrl.searchParams.set('selected', selectedWorkflowId)
	}
	return `${requestUrl.pathname}${requestUrl.search}`
}

export async function accountWorkflowsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const href = `${url.pathname}${url.search}`
	const response = await fetch(buildWorkflowsApiRequestUrl(href), {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountWorkflowsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load workflow runs.')
	}
	return { accountWorkflows: payload }
}

function sourceLabel(workflow: Pick<AccountWorkflowListItem, 'sourceType'>) {
	switch (workflow.sourceType) {
		case 'inline':
			return 'Inline'
		case 'package':
			return 'Package'
		default: {
			const exhaustive: never = workflow.sourceType
			return exhaustive
		}
	}
}

function packageValue(
	workflow: Pick<AccountWorkflowListItem, 'sourceType' | 'packageId'>,
) {
	if (workflow.sourceType !== 'package' || !workflow.packageId) return '—'
	return (
		<a
			href={routes.accountPackageDetail.href({
				packageId: workflow.packageId,
			})}
			mix={css(primaryLinkCss)}
		>
			{workflow.packageId}
		</a>
	)
}

function statusLabel(status: AccountWorkflowRunStatus | null) {
	if (status === null) return 'Creating'
	switch (status) {
		case 'queued':
			return 'Queued'
		case 'running':
			return 'Running'
		case 'paused':
			return 'Paused'
		case 'waiting':
			return 'Waiting'
		case 'waitingForPause':
			return 'Waiting for pause'
		case 'unknown':
			return 'Unknown'
		case 'complete':
			return 'Complete'
		case 'errored':
			return 'Errored'
		case 'terminated':
			return 'Terminated'
		case 'cancelled':
			return 'Cancelled'
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

function statusColor(status: AccountWorkflowRunStatus | null) {
	if (status === null) return colors.textMuted
	switch (status) {
		case 'queued':
		case 'waiting':
		case 'waitingForPause':
		case 'paused':
		case 'unknown':
			return colors.textMuted
		case 'running':
			return colors.primary
		case 'complete':
			return colors.primary
		case 'errored':
		case 'terminated':
		case 'cancelled':
			return colors.error
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

function tryConsumeAccountWorkflowsLoaderData(handle: Handle, href: string) {
	return tryConsumeRouteLoaderData(handle, 'accountWorkflows', href)
}

export function AccountWorkflowsRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let actionState: 'idle' | 'busy' = 'idle'
	let workflows: Array<AccountWorkflowListItem> = []
	let selectedWorkflow: AccountWorkflowDetail | null = null
	let message: string | null = null
	let messageTone: MessageTone = 'info'
	const loadLatch = createRouteLoadLatch()
	const cancelWorkflowCheck = createDoubleCheck(handle)

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
		view?: AccountWorkflowsViewFilter
	}) {
		const nextUrl = new URL(getCurrentHref(), 'http://localhost')
		const search = next.search ?? nextUrl.searchParams.get('q')?.trim() ?? ''
		const view = next.view ?? readWorkflowsViewFilter(nextUrl.href)
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

	function applyPayload(payload: AccountWorkflowsLoaderData) {
		workflows = payload.workflows
		selectedWorkflow = payload.selectedWorkflow
		cancelWorkflowCheck.reset()
	}

	async function loadWorkflows(signal: AbortSignal) {
		const href = getCurrentHref()
		const latchKey = getDataLatchKey(href)
		try {
			const response = await fetch(buildWorkflowsApiRequestUrl(href), {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountWorkflowsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load workflow runs.')
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
					: 'Unable to load workflow runs.',
				'error',
			)
			loadLatch.markFailed(latchKey)
			handle.update()
		}
	}

	async function postAction(input: {
		body: Record<string, unknown>
		successMessage: (
			payload: AccountWorkflowsLoaderData & {
				cancel?: {
					cancelled: boolean
					alreadyTerminal: boolean
					status: AccountWorkflowRunStatus | null
				}
			},
		) => string | null
		failureMessage: string
	}) {
		if (actionState !== 'idle') return
		actionState = 'busy'
		setMessage(null)
		handle.update()
		try {
			const response = await fetch(accountWorkflowsApiPath, {
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
				AccountWorkflowsLoaderData & {
					error?: string
					ok?: boolean
					cancel?: {
						cancelled: boolean
						alreadyTerminal: boolean
						status: AccountWorkflowRunStatus | null
					}
				}
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error || input.failureMessage)
			}
			applyPayload(payload)
			actionState = 'idle'
			setMessage(input.successMessage(payload))
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
		if (!workflowsRoute.isRoutePath(href)) return false
		const routeData = tryConsumeAccountWorkflowsLoaderData(handle, href)
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
			handle.queueTask(loadWorkflows)
		}
		const isMutating = actionState !== 'idle'
		const selection = workflowsRoute.getSelection(currentHref)
		const search = readWorkflowsSearchFilter(currentHref)
		const view = readWorkflowsViewFilter(currentHref)
		const filteredWorkflows = filterAccountWorkflows(workflows, {
			view,
			search,
		})
		const listEmptyMessage = emptyWorkflowsMessage({
			totalCount: workflows.length,
			filteredCount: filteredWorkflows.length,
			view,
			search,
		})
		const detail =
			selectedWorkflow && selectedWorkflow.id === selection.selectedId
				? selectedWorkflow
				: null
		const listMatch =
			workflows.find((item) => item.id === selection.selectedId) ?? null
		const waitingForDetail =
			selection.selectedId != null &&
			!detail &&
			(needsLoad || listMatch != null || status === 'loading')
		const showWorkflowNotFound =
			selection.selectedId != null &&
			!detail &&
			!waitingForDetail &&
			status === 'ready'
		const canCancel = detail ? isActiveAccountWorkflow(detail) : false

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Workflows"
					description="Inspect deferred and long-running workflow runs — inline or package-backed — including status, schedule time, and errors. Cancel a run that has not finished yet."
					currentHref={currentHref}
				/>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading workflows...
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
					<RecordTable
						mode="expand"
						ariaLabel="Workflow runs"
						selectedId={selection.selectedId}
						onNavigate={() => {
							cancelWorkflowCheck.reset()
							setMessage(null)
						}}
						countLabel={`${filteredWorkflows.length} of ${workflows.length} shown`}
						emptyLabel={
							listEmptyMessage ?? 'No workflows match the current filters.'
						}
						toolbar={
							<>
								<RecordTableSearch
									label="Search workflows"
									placeholder="Search workflows"
									value={search}
									onInput={(value) => {
										replaceLocation(
											buildHrefWithUpdatedFilters({ search: value }),
										)
									}}
								/>
								<RecordTableSelect
									label="Workflows view filter"
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
							{ key: 'name', label: 'Workflow', primary: true },
							{ key: 'source', label: 'Source', drop: 2 },
							{ key: 'status', label: 'Status' },
							{ key: 'runAt', label: 'Run at', drop: 1 },
							{ key: 'updated', label: 'Updated', drop: 3 },
						]}
						rows={filteredWorkflows.map((item) => ({
							id: item.id,
							href: isMutating
								? undefined
								: workflowsRoute.buildDetailHref(item.id, getCurrentSearch()),
							cells: {
								name: <span mix={clampedCellCss}>{item.workflowName}</span>,
								source: sourceLabel(item),
								status: (
									<span mix={css({ color: statusColor(item.status) })}>
										{statusLabel(item.status)}
									</span>
								),
								runAt: (
									<span mix={css(recordStampCss)}>
										<TimestampValue value={item.runAt} />
									</span>
								),
								updated: (
									<span mix={css(recordStampCss)}>
										<TimestampValue value={item.updatedAt} />
									</span>
								),
							},
						}))}
						record={
							detail ? (
								<section mix={css(recordBodyCss)}>
									<div mix={css({ display: 'grid', gap: spacing.xs })}>
										<h2 mix={css(cardTitleCss)}>{detail.workflowName}</h2>
										<p mix={css(descriptionCss)}>
											{detail.sourceType === 'package'
												? 'Package workflow run. Cancel stops the underlying Cloudflare Workflow instance when it has not finished yet.'
												: 'Inline workflow run. Cancel stops the underlying Cloudflare Workflow instance when it has not finished yet.'}
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
												label: 'Source',
												value: sourceLabel(detail),
											},
											{
												label: 'Package',
												value: packageValue(detail),
											},
											{
												label: 'Export',
												value: detail.exportName ?? '—',
											},
											{
												label: 'Run at',
												value: <TimestampValue value={detail.runAt} />,
											},
											{
												label: 'Plan date',
												value: detail.planDate ?? '—',
											},
											{
												label: 'Created',
												value: <TimestampValue value={detail.createdAt} />,
											},
											{
												label: 'Updated',
												value: <TimestampValue value={detail.updatedAt} />,
											},
											{
												label: 'Completed',
												value: <TimestampValue value={detail.completedAt} />,
											},
											{
												label: 'Idempotency key',
												value: (
													<IdValue
														value={detail.idempotencyKey}
														label="idempotency key"
													/>
												),
											},
											{
												label: 'Workflow id',
												value: (
													<IdValue value={detail.id} label="workflow id" />
												),
											},
											{
												label: 'Kody id',
												value: detail.kodyId ? (
													<IdValue value={detail.kodyId} label="kody id" />
												) : (
													'—'
												),
											},
											{
												label: 'Source id',
												value: detail.sourceId ? (
													<IdValue value={detail.sourceId} label="source id" />
												) : (
													'—'
												),
											},
										]}
									/>

									{detail.lastError ? (
										<AccountManagementMessage tone="error">
											{detail.lastError}
										</AccountManagementMessage>
									) : null}

									{canCancel ? (
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
													...cancelWorkflowCheck.getButtonMix({
														on: {
															click: () =>
																void postAction({
																	body: {
																		action: 'cancel',
																		id: detail.id,
																	},
																	successMessage: (payload) => {
																		if (payload.cancel?.alreadyTerminal) {
																			return `Workflow already finished with status "${statusLabel(payload.cancel.status)}".`
																		}
																		return 'Cancelled workflow run.'
																	},
																	failureMessage:
																		'Unable to cancel workflow run.',
																}),
														},
														resetAfterAction: false,
													}),
													css(dangerButtonCss),
												]}
											>
												{cancelWorkflowCheck.doubleCheck
													? 'Confirm cancel'
													: 'Cancel run'}
											</button>
											{cancelWorkflowCheck.doubleCheck ? (
												<button
													type="button"
													disabled={isMutating}
													mix={[
														on('click', () => {
															cancelWorkflowCheck.reset()
															handle.update()
														}),
														css(secondaryButtonCss),
													]}
												>
													Keep running
												</button>
											) : null}
										</div>
									) : null}
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
										{listMatch?.workflowName ?? 'Loading workflow'}
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										Loading workflow details...
									</p>
								</div>
							) : showWorkflowNotFound ? (
								<div mix={css({ ...recordBodyCss, gap: spacing.sm })}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
										})}
									>
										Workflow not found
									</h2>
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										This workflow run does not exist for this account or is
										unavailable.
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
