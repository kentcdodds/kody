import { formatNullableTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'
import {
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	inputCss,
} from '#client/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	accountManagementTableCellCss,
	accountManagementTableCss,
} from './account-management-components.tsx'
import {
	type AdminCodemodListItem,
	type AdminCodemodRunItemListItem,
	type AdminCodemodRunItemsLoaderData,
	type AdminCodemodRunListItem,
	type AdminCodemodsLoaderData,
} from '#app/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type PageStatus = 'loading' | 'ready' | 'error'
type RunMode = 'scan' | 'dry-run' | 'apply' | 'revert'
type RunPhase = 'idle' | 'running' | 'complete' | 'error'

type LiveRunItem = {
	itemId: string
	userId: string
	packageId: string
	kodyId: string
	status: string
	changedPaths: Array<string>
	findings: Array<{ path: string | null; message: string }>
	error: string | null
}

const adminCodemodsApiPath = '/admin/codemods.json'
const adminCodemodsRunApiPath = '/admin/codemods/run.json'
const maxRunSteps = 200

const runModes = [
	'scan',
	'dry-run',
	'apply',
	'revert',
] as const satisfies ReadonlyArray<RunMode>

function isAdminCodemodsPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/codemods'
}

function parseCommaSeparatedIds(value: string): Array<string> {
	return value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

function mergeSummaryCounts(
	left: Record<string, number>,
	right: Partial<Record<string, number>>,
) {
	const next = { ...left }
	for (const [status, count] of Object.entries(right)) {
		if (typeof count !== 'number') continue
		next[status] = (next[status] ?? 0) + count
	}
	return next
}

function formatSummaryCounts(summary: Record<string, number>) {
	const entries = Object.entries(summary).sort(([left], [right]) =>
		left.localeCompare(right),
	)
	if (entries.length === 0) return 'No items yet'
	return entries.map(([status, count]) => `${status}: ${count}`).join(' · ')
}

function formatFindings(
	findings: Array<{ path: string | null; message: string }>,
) {
	if (findings.length === 0) return '—'
	return findings
		.map((finding) =>
			finding.path ? `${finding.path}: ${finding.message}` : finding.message,
		)
		.join('; ')
}

export async function adminCodemodsRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(adminCodemodsApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view package codemods.')
	}
	const payload = await readJson<AdminCodemodsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load package codemods.')
	}
	return { adminCodemods: payload }
}

export function AdminCodemodsRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let codemods: Array<AdminCodemodListItem> = []
	let runs: Array<AdminCodemodRunListItem> = []
	let message: string | null = null
	let messageTone: 'info' | 'error' = 'info'
	let loadRequestId = 0
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null

	let selectedCodemodId = ''
	let selectedMode: RunMode = 'scan'
	let userIdsFilter = ''
	let packageIdsFilter = ''
	let revertOfRunId = ''

	let runPhase: RunPhase = 'idle'
	let stopRequested = false
	let liveRunId: string | null = null
	let liveItems: Array<LiveRunItem> = []
	let liveSummary: Record<string, number> = {}
	let pendingConfirmKey: string | null = null

	let selectedHistoryRunId: string | null = null
	let historyItems: Array<AdminCodemodRunItemListItem> = []
	let historyRun: AdminCodemodRunListItem | null = null
	let historyLoading = false
	let historyNextAfterId: string | null = null
	let historyRequestId = 0

	function applyData(payload: AdminCodemodsLoaderData) {
		codemods = payload.codemods
		runs = payload.runs
		if (
			!selectedCodemodId ||
			!codemods.some((codemod) => codemod.id === selectedCodemodId)
		) {
			selectedCodemodId = codemods[0]?.id ?? ''
		}
		status = 'ready'
		message = null
		messageTone = 'info'
	}

	async function loadCodemods() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminCodemodsApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view package codemods.'
				messageTone = 'error'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminCodemodsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load package codemods.')
			}
			applyData(payload)
			lastLoadedHref = href
			lastFailedHref = null
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load package codemods.'
			messageTone = 'error'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	async function refreshRuns() {
		const response = await fetch(adminCodemodsApiPath, {
			headers: { Accept: 'application/json' },
			credentials: 'include',
		})
		if (response.status === 401) {
			window.location.assign('/login')
			return
		}
		const payload = await readJson<AdminCodemodsLoaderData>(response)
		if (!response.ok || !payload?.ok) return
		runs = payload.runs
		codemods = payload.codemods
		handle.update()
	}

	async function loadHistoryRun(runId: string, append = false) {
		const requestId = ++historyRequestId
		historyLoading = true
		if (!append) {
			selectedHistoryRunId = runId
			historyItems = []
			historyRun = null
			historyNextAfterId = null
		}
		handle.update()
		try {
			const url = new URL(adminCodemodsApiPath, window.location.origin)
			url.searchParams.set('runId', runId)
			if (append && historyNextAfterId) {
				url.searchParams.set('afterId', historyNextAfterId)
			}
			const response = await fetch(url.pathname + url.search, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
			})
			if (requestId !== historyRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<
				AdminCodemodRunItemsLoaderData & { error?: string }
			>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to load run items.')
			}
			historyRun = payload.run
			historyItems = append
				? [...historyItems, ...payload.items]
				: payload.items
			historyNextAfterId = payload.nextAfterId
			handle.update()
		} catch (error) {
			if (requestId !== historyRequestId) return
			message =
				error instanceof Error ? error.message : 'Unable to load run items.'
			messageTone = 'error'
			handle.update()
		} finally {
			if (requestId === historyRequestId) {
				historyLoading = false
				handle.update()
			}
		}
	}

	function buildRunBody(input: {
		runId?: string
		cursor?: string | null
		revertOfRunId?: string
		mode: RunMode
		codemodId: string
	}) {
		const userIds = parseCommaSeparatedIds(userIdsFilter)
		const packageIds = parseCommaSeparatedIds(packageIdsFilter)
		const body: Record<string, unknown> = {
			codemodId: input.codemodId,
			mode: input.mode,
			scope: 'fleet',
		}
		if (userIds.length > 0 || packageIds.length > 0) {
			body.filters = {
				...(userIds.length > 0 ? { userIds } : {}),
				...(packageIds.length > 0 ? { packageIds } : {}),
			}
		}
		if (input.runId) body.runId = input.runId
		if (input.cursor !== undefined) body.cursor = input.cursor
		if (input.mode === 'revert') {
			body.revertOfRunId = input.revertOfRunId
		}
		return body
	}

	async function postRunStep(body: Record<string, unknown>) {
		const response = await fetch(adminCodemodsRunApiPath, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify(body),
		})
		if (response.status === 401) {
			window.location.assign('/login')
			return null
		}
		const payload = await readJson<{
			ok?: boolean
			error?: string
			runId?: string
			codemodId?: string
			mode?: string
			items?: Array<LiveRunItem>
			nextCursor?: string | null
			summary?: Partial<Record<string, number>>
		}>(response)
		if (!response.ok || !payload?.ok) {
			throw new Error(payload?.error ?? 'Unable to run package codemod step.')
		}
		return payload
	}

	async function runPagedCodemod(input: {
		mode: RunMode
		codemodId: string
		revertOfRunId?: string
	}) {
		runPhase = 'running'
		stopRequested = false
		liveRunId = null
		liveItems = []
		liveSummary = {}
		message = null
		messageTone = 'info'
		pendingConfirmKey = null
		handle.update()

		let runId: string | undefined
		let cursor: string | null | undefined
		let stepCount = 0
		try {
			for (;;) {
				if (stopRequested) {
					runPhase = 'complete'
					message = `Stopped ${input.mode} for ${input.codemodId}${liveRunId ? ` (run ${liveRunId})` : ''} after ${stepCount} step(s).`
					messageTone = 'info'
					await refreshRuns()
					handle.update()
					return
				}
				if (stepCount >= maxRunSteps) {
					runPhase = 'error'
					message = `Stopped after ${maxRunSteps} steps without completing. Resume later with the same run id if needed.`
					messageTone = 'error'
					await refreshRuns()
					handle.update()
					return
				}

				const previousCursor = cursor
				const step = await postRunStep(
					buildRunBody({
						runId,
						cursor,
						mode: input.mode,
						codemodId: input.codemodId,
						revertOfRunId: input.revertOfRunId,
					}),
				)
				if (!step) return
				stepCount += 1
				runId = step.runId
				liveRunId = step.runId ?? null
				if (Array.isArray(step.items)) {
					liveItems = [
						...liveItems,
						...step.items.map((item) => ({
							itemId: item.itemId,
							userId: item.userId,
							packageId: item.packageId,
							kodyId: item.kodyId,
							status: item.status,
							changedPaths: item.changedPaths ?? [],
							findings: item.findings ?? [],
							error: item.error ?? null,
						})),
					]
				}
				if (step.summary) {
					liveSummary = mergeSummaryCounts(liveSummary, step.summary)
				}
				handle.update()
				if (step.nextCursor == null) break
				if (
					previousCursor !== undefined &&
					previousCursor === step.nextCursor
				) {
					runPhase = 'error'
					message = `Codemod run stopped: cursor did not advance (${step.nextCursor}).`
					messageTone = 'error'
					await refreshRuns()
					handle.update()
					return
				}
				cursor = step.nextCursor
			}
			runPhase = 'complete'
			message = `Finished ${input.mode} for ${input.codemodId}${liveRunId ? ` (run ${liveRunId})` : ''}.`
			messageTone = 'info'
			await refreshRuns()
			handle.update()
		} catch (error) {
			runPhase = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to complete package codemod run.'
			messageTone = 'error'
			handle.update()
		} finally {
			stopRequested = false
		}
	}

	function getConfirmKey(action: string, id: string) {
		return `${action}:${id}`
	}

	function getDestructiveButtonMix(
		action: string,
		id: string,
		onConfirm: () => void,
	) {
		const key = getConfirmKey(action, id)
		return [
			on('blur', () => {
				if (pendingConfirmKey === key) {
					pendingConfirmKey = null
					handle.update()
				}
			}),
			on('click', (event) => {
				if (pendingConfirmKey !== key) {
					event.preventDefault()
					pendingConfirmKey = key
					handle.update()
					return
				}
				pendingConfirmKey = null
				onConfirm()
			}),
		]
	}

	function handleRunSubmit(event: SubmitEvent) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		if (!selectedCodemodId) {
			message = 'Select a codemod first.'
			messageTone = 'error'
			handle.update()
			return
		}
		if (selectedMode === 'apply' || selectedMode === 'revert') {
			message = `Use the ${selectedMode} button and confirm to start a destructive run.`
			messageTone = 'info'
			handle.update()
			return
		}
		void runPagedCodemod({
			mode: selectedMode,
			codemodId: selectedCodemodId,
		})
	}

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()
	const tableCss = accountManagementTableCss
	const cellCss = accountManagementTableCellCss

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const routeData = isAdminCodemodsPath(currentHref)
			? tryConsumeRouteLoaderData(handle, 'adminCodemods', currentHref)
			: undefined
		if (routeData) {
			applyData(routeData)
			lastLoadedHref = currentHref
			lastFailedHref = null
		}
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !routeData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!routeData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadCodemods)
		}

		const isRunning = runPhase === 'running'
		const canMutate = !isRunning && status === 'ready'
		const applyConfirmActive =
			pendingConfirmKey === getConfirmKey('apply', selectedCodemodId)
		const revertFormConfirmActive =
			pendingConfirmKey === getConfirmKey('revert-form', selectedCodemodId)

		return (
			<AccountManagementShell>
				<AdminPageHeader
					title="Admin codemods"
					description="Scan, dry-run, apply, and revert package codemods across the fleet."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading package codemods…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				) : null}
				<div mix={css({ display: 'grid', gap: spacing.lg })}>
					<AccountManagementPanel
						title="Registered codemods"
						description="Transforms available to the package codemod engine."
					>
						{codemods.length === 0 ? (
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								No package codemods are registered.
							</p>
						) : (
							<ul
								mix={css({
									margin: 0,
									paddingLeft: spacing.lg,
									display: 'grid',
									gap: spacing.sm,
								})}
							>
								{codemods.map((codemod) => (
									<li key={codemod.id}>
										<code mix={css({ fontSize: typography.fontSize.sm })}>
											{codemod.id}
										</code>
										<p
											mix={css({
												margin: `${spacing.xs} 0 0`,
												color: colors.textMuted,
											})}
										>
											{codemod.description}
										</p>
									</li>
								))}
							</ul>
						)}
					</AccountManagementPanel>

					<AccountManagementPanel
						title="Run codemod"
						description="Each click walks the fleet in pages until nextCursor is null (stop anytime; hard ceiling 200 steps). Apply and revert require an explicit scope and confirmation."
					>
						<form
							mix={[
								css({
									display: 'grid',
									gap: spacing.md,
								}),
								on('submit', handleRunSubmit),
							]}
						>
							<div
								mix={css({
									display: 'grid',
									gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
									gap: spacing.md,
									[mq.mobile]: {
										gridTemplateColumns: 'minmax(0, 1fr)',
									},
								})}
							>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Codemod</span>
									<select
										name="codemodId"
										value={selectedCodemodId}
										disabled={!canMutate}
										mix={[
											css(inputCss),
											on('change', (event) => {
												if (!(event.currentTarget instanceof HTMLSelectElement))
													return
												selectedCodemodId = event.currentTarget.value
												handle.update()
											}),
										]}
									>
										{codemods.map((codemod) => (
											<option key={codemod.id} value={codemod.id}>
												{codemod.id}
											</option>
										))}
									</select>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Mode</span>
									<select
										name="mode"
										value={selectedMode}
										disabled={!canMutate}
										mix={[
											css(inputCss),
											on('change', (event) => {
												if (!(event.currentTarget instanceof HTMLSelectElement))
													return
												const next = event.currentTarget.value
												for (const mode of runModes) {
													if (mode === next) {
														selectedMode = mode
														handle.update()
														return
													}
												}
											}),
										]}
									>
										{runModes.map((mode) => (
											<option key={mode} value={mode}>
												{mode}
											</option>
										))}
									</select>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>User IDs filter</span>
									<input
										name="userIds"
										type="text"
										placeholder="comma-separated stable user ids"
										value={userIdsFilter}
										disabled={!canMutate}
										mix={[
											css(inputCss),
											on('input', (event) => {
												if (!(event.currentTarget instanceof HTMLInputElement))
													return
												userIdsFilter = event.currentTarget.value
												handle.update()
											}),
										]}
									/>
								</label>
								<label mix={css(fieldCss)}>
									<span mix={css(fieldLabelCss)}>Package IDs filter</span>
									<input
										name="packageIds"
										type="text"
										placeholder="comma-separated package ids"
										value={packageIdsFilter}
										disabled={!canMutate}
										mix={[
											css(inputCss),
											on('input', (event) => {
												if (!(event.currentTarget instanceof HTMLInputElement))
													return
												packageIdsFilter = event.currentTarget.value
												handle.update()
											}),
										]}
									/>
								</label>
								{selectedMode === 'revert' ? (
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Revert of run ID</span>
										<input
											name="revertOfRunId"
											type="text"
											required
											placeholder="completed apply run id"
											value={revertOfRunId}
											disabled={!canMutate}
											mix={[
												css(inputCss),
												on('input', (event) => {
													if (
														!(event.currentTarget instanceof HTMLInputElement)
													)
														return
													revertOfRunId = event.currentTarget.value
													handle.update()
												}),
											]}
										/>
									</label>
								) : null}
							</div>
							<div
								mix={css({
									display: 'flex',
									gap: spacing.sm,
									flexWrap: 'wrap',
									alignItems: 'center',
								})}
							>
								{selectedMode === 'apply' ? (
									<button
										type="button"
										disabled={!canMutate || !selectedCodemodId}
										mix={[
											...getDestructiveButtonMix(
												'apply',
												selectedCodemodId,
												() => {
													void runPagedCodemod({
														mode: 'apply',
														codemodId: selectedCodemodId,
													})
												},
											),
											css(dangerButtonCss),
										]}
									>
										{isRunning
											? 'Running…'
											: applyConfirmActive
												? 'Confirm apply'
												: 'Apply'}
									</button>
								) : selectedMode === 'revert' ? (
									<button
										type="button"
										disabled={
											!canMutate || !selectedCodemodId || !revertOfRunId.trim()
										}
										mix={[
											...getDestructiveButtonMix(
												'revert-form',
												selectedCodemodId,
												() => {
													void runPagedCodemod({
														mode: 'revert',
														codemodId: selectedCodemodId,
														revertOfRunId: revertOfRunId.trim(),
													})
												},
											),
											css(dangerButtonCss),
										]}
									>
										{isRunning
											? 'Running…'
											: revertFormConfirmActive
												? 'Confirm revert'
												: 'Revert'}
									</button>
								) : (
									<button
										type="submit"
										disabled={!canMutate || !selectedCodemodId}
										mix={css(primaryButtonCss)}
									>
										{isRunning ? 'Running…' : 'Run'}
									</button>
								)}
								{isRunning ? (
									<button
										type="button"
										disabled={stopRequested}
										mix={[
											on('click', () => {
												stopRequested = true
												handle.update()
											}),
											css(secondaryButtonCss),
										]}
									>
										{stopRequested ? 'Stopping…' : 'Stop'}
									</button>
								) : null}
								{liveRunId ? (
									<p mix={css({ margin: 0, color: colors.textMuted })}>
										Run {liveRunId} · {formatSummaryCounts(liveSummary)}
									</p>
								) : null}
							</div>
						</form>
					</AccountManagementPanel>

					{liveItems.length > 0 || runPhase !== 'idle' ? (
						<AccountManagementPanel
							title="Live results"
							description={formatSummaryCounts(liveSummary)}
						>
							<div mix={css({ overflowX: 'auto' })}>
								<table mix={css(tableCss)}>
									<thead>
										<tr>
											<th mix={css(cellCss)}>kodyId</th>
											<th mix={css(cellCss)}>userId</th>
											<th mix={css(cellCss)}>status</th>
											<th mix={css(cellCss)}>changedPaths</th>
											<th mix={css(cellCss)}>findings</th>
											<th mix={css(cellCss)}>error</th>
										</tr>
									</thead>
									<tbody>
										{liveItems.map((item) => (
											<tr key={item.itemId}>
												<td mix={css(cellCss)}>{item.kodyId}</td>
												<td mix={css(cellCss)}>{item.userId}</td>
												<td mix={css(cellCss)}>{item.status}</td>
												<td mix={css(cellCss)}>
													{item.changedPaths.join(', ') || '—'}
												</td>
												<td mix={css(cellCss)}>
													{formatFindings(item.findings)}
												</td>
												<td mix={css(cellCss)}>{item.error ?? '—'}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							{liveItems.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									{isRunning ? 'Waiting for the first page…' : 'No items.'}
								</p>
							) : null}
						</AccountManagementPanel>
					) : null}

					<AccountManagementPanel
						title="Run history"
						description="Recent fleet and filtered package codemod runs."
					>
						{runs.length === 0 ? (
							<p mix={css({ margin: 0, color: colors.textMuted })}>
								No runs recorded yet.
							</p>
						) : (
							<div mix={css({ display: 'grid', gap: spacing.md })}>
								<div mix={css({ overflowX: 'auto' })}>
									<table mix={css(tableCss)}>
										<thead>
											<tr>
												<th mix={css(cellCss)}>Created</th>
												<th mix={css(cellCss)}>Codemod</th>
												<th mix={css(cellCss)}>Mode</th>
												<th mix={css(cellCss)}>Status</th>
												<th mix={css(cellCss)}>Scope</th>
												<th mix={css(cellCss)}>Actions</th>
											</tr>
										</thead>
										<tbody>
											{runs.map((run) => {
												const revertConfirmActive =
													pendingConfirmKey ===
													getConfirmKey('revert-history', run.id)
												const canRevert =
													run.mode === 'apply' && run.status === 'completed'
												return (
													<tr key={run.id}>
														<td mix={css(cellCss)}>
															{formatNullableTimestamp(run.createdAt)}
														</td>
														<td mix={css(cellCss)}>
															<code
																mix={css({
																	fontSize: typography.fontSize.sm,
																})}
															>
																{run.codemodId}
															</code>
														</td>
														<td mix={css(cellCss)}>{run.mode}</td>
														<td mix={css(cellCss)}>{run.status}</td>
														<td mix={css(cellCss)}>
															{run.scopeUserId ?? 'fleet'}
														</td>
														<td mix={css(cellCss)}>
															<div
																mix={css({
																	display: 'flex',
																	gap: spacing.xs,
																	flexWrap: 'wrap',
																})}
															>
																<button
																	type="button"
																	disabled={historyLoading}
																	mix={[
																		on('click', () => {
																			void loadHistoryRun(run.id)
																		}),
																		css(secondaryButtonCss),
																	]}
																>
																	{selectedHistoryRunId === run.id &&
																	historyLoading
																		? 'Loading…'
																		: 'Details'}
																</button>
																{canRevert ? (
																	<button
																		type="button"
																		disabled={!canMutate}
																		mix={[
																			...getDestructiveButtonMix(
																				'revert-history',
																				run.id,
																				() => {
																					selectedCodemodId = run.codemodId
																					selectedMode = 'revert'
																					revertOfRunId = run.id
																					void runPagedCodemod({
																						mode: 'revert',
																						codemodId: run.codemodId,
																						revertOfRunId: run.id,
																					})
																				},
																			),
																			css(dangerButtonCss),
																		]}
																	>
																		{revertConfirmActive
																			? 'Confirm revert'
																			: 'Revert'}
																	</button>
																) : null}
															</div>
														</td>
													</tr>
												)
											})}
										</tbody>
									</table>
								</div>

								{selectedHistoryRunId ? (
									<div mix={css({ display: 'grid', gap: spacing.sm })}>
										<p mix={css(descriptionCss)}>
											Details for <code>{selectedHistoryRunId}</code>
											{historyRun
												? ` · ${historyRun.mode} · ${historyRun.status}`
												: ''}
										</p>
										{historyLoading && historyItems.length === 0 ? (
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												Loading items…
											</p>
										) : null}
										{historyItems.length > 0 ? (
											<div mix={css({ overflowX: 'auto' })}>
												<table mix={css(tableCss)}>
													<thead>
														<tr>
															<th mix={css(cellCss)}>kodyId</th>
															<th mix={css(cellCss)}>userId</th>
															<th mix={css(cellCss)}>status</th>
															<th mix={css(cellCss)}>changedPaths</th>
															<th mix={css(cellCss)}>findings</th>
															<th mix={css(cellCss)}>error</th>
														</tr>
													</thead>
													<tbody>
														{historyItems.map((item) => (
															<tr key={item.id}>
																<td mix={css(cellCss)}>{item.kodyId}</td>
																<td mix={css(cellCss)}>{item.userId}</td>
																<td mix={css(cellCss)}>{item.status}</td>
																<td mix={css(cellCss)}>
																	{item.changedPaths.join(', ') || '—'}
																</td>
																<td mix={css(cellCss)}>
																	{formatFindings(item.findings)}
																</td>
																<td mix={css(cellCss)}>{item.error ?? '—'}</td>
															</tr>
														))}
													</tbody>
												</table>
											</div>
										) : !historyLoading ? (
											<p mix={css({ margin: 0, color: colors.textMuted })}>
												No items for this run.
											</p>
										) : null}
										{historyNextAfterId ? (
											<button
												type="button"
												disabled={historyLoading}
												mix={[
													on('click', () => {
														if (!selectedHistoryRunId) return
														void loadHistoryRun(selectedHistoryRunId, true)
													}),
													css(secondaryButtonCss),
												]}
											>
												{historyLoading ? 'Loading…' : 'Load more'}
											</button>
										) : null}
									</div>
								) : null}
							</div>
						)}
					</AccountManagementPanel>
				</div>
			</AccountManagementShell>
		)
	}
}
