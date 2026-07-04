import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getSecondaryButtonCss,
	inputCss,
} from '#client/styles/style-primitives.ts'
import {
	AccountManagementHeader,
	AccountManagementMessage,
	AccountManagementShell,
} from './account-management-components.tsx'

type ReportStatus = 'open' | 'resolved' | 'dismissed'

type AdminCommunityReportListItem = {
	id: string
	listingId: string
	listingName: string
	listingOwnerUserId: string
	reporterUserId: string
	reason: string
	status: ReportStatus
	createdAt: string
	resolvedAt: string | null
	resolutionNote: string | null
}

type AdminCommunityReportsPayload = {
	ok: true
	reports: Array<AdminCommunityReportListItem>
	statusFilter: string
}

type PageStatus = 'loading' | 'ready' | 'error'
type ReportIntent =
	| 'dismiss'
	| 'delist'
	| 'delete'
	| 'ban_reporter'
	| 'ban_reportee'

const adminCommunityReportsApiPath = '/admin/community-reports.json'

const statusOptions = [
	{ value: 'open', label: 'Open' },
	{ value: 'resolved', label: 'Resolved' },
	{ value: 'dismissed', label: 'Dismissed' },
	{ value: 'all', label: 'All' },
] as const

function getCurrentHref() {
	return typeof window === 'undefined'
		? '/admin/community-reports'
		: window.location.href
}

function formatTimestamp(value: string) {
	return new Date(value).toLocaleString()
}

function buildReportsHref(status: string) {
	const url = new URL(getCurrentHref(), 'http://localhost')
	if (status === 'open') url.searchParams.delete('status')
	else url.searchParams.set('status', status)
	return `${url.pathname}${url.search}`
}

export function AdminCommunityReportsRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let reports: Array<AdminCommunityReportListItem> = []
	let statusFilter = 'open'
	let message: string | null = null
	let actionState: 'idle' | 'acting' = 'idle'
	let noteByReportId = new Map<string, string>()
	let pendingDoubleCheckKey: string | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''

	function getDoubleCheckKey(reportId: string, intent: ReportIntent) {
		return `${reportId}:${intent}`
	}

	function isDoubleCheckActive(reportId: string, intent: ReportIntent) {
		return pendingDoubleCheckKey === getDoubleCheckKey(reportId, intent)
	}

	function getDestructiveButtonMix(
		reportId: string,
		intent: ReportIntent,
		onConfirm: () => void,
	) {
		const key = getDoubleCheckKey(reportId, intent)
		return [
			on('blur', () => {
				if (pendingDoubleCheckKey === key) {
					pendingDoubleCheckKey = null
					handle.update()
				}
			}),
			on('click', (event) => {
				if (pendingDoubleCheckKey !== key) {
					event.preventDefault()
					pendingDoubleCheckKey = key
					handle.update()
					return
				}
				pendingDoubleCheckKey = null
				onConfirm()
			}),
		]
	}

	function getNote(reportId: string) {
		return noteByReportId.get(reportId) ?? ''
	}

	function setNote(reportId: string, value: string) {
		noteByReportId.set(reportId, value)
		handle.update()
	}

	async function loadReports() {
		const href = getCurrentHref()
		const requestId = ++loadRequestId
		try {
			const response = await fetch(
				`${adminCommunityReportsApiPath}${new URL(href).search}`,
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
				},
			)
			if (requestId !== loadRequestId) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 403) {
				status = 'error'
				message = 'You do not have permission to view community reports.'
				handle.update()
				return
			}
			const payload = await readJson<AdminCommunityReportsPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load community reports.')
			}
			reports = payload.reports
			statusFilter = payload.statusFilter
			status = 'ready'
			message = null
			lastLoadedHref = href
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load community reports.'
			handle.update()
		}
	}

	async function submitReportAction(reportId: string, intent: ReportIntent) {
		if (actionState !== 'idle') return
		actionState = 'acting'
		message = null
		handle.update()

		try {
			const response = await fetch(adminCommunityReportsApiPath, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({
					intent,
					reportId,
					note: getNote(reportId) || undefined,
				}),
			})
			const payload = await readJson<{ ok: boolean; error?: string }>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to complete action.')
			}
			actionState = 'idle'
			status = 'loading'
			handle.update()
		} catch (error) {
			actionState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to complete action.'
			handle.update()
		}
	}

	listenToRouterNavigation(handle, () => {
		const href = getCurrentHref()
		if (href !== lastLoadedHref) {
			status = 'loading'
			handle.update()
		}
	})

	const secondaryButtonCss = getSecondaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()

	return () => {
		const currentHref = getCurrentHref()
		const isMutating = actionState !== 'idle'

		if (status === 'loading' || currentHref !== lastLoadedHref) {
			handle.queueTask(loadReports)
		}

		return (
			<AccountManagementShell>
				<AccountManagementHeader
					title="Community reports"
					description="Review open reports and moderate community listings."
					actions={
						<>
							<a
								href="/admin/users"
								mix={css({ ...secondaryButtonCss, textDecoration: 'none' })}
							>
								View users
							</a>
							<a
								href="/admin/roles"
								mix={css({ ...secondaryButtonCss, textDecoration: 'none' })}
							>
								View roles
							</a>
						</>
					}
				/>

				<div mix={css({ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' })}>
					{statusOptions.map((option) => (
						<a
							key={option.value}
							href={buildReportsHref(option.value)}
							aria-current={statusFilter === option.value ? 'page' : undefined}
							mix={css({
								...secondaryButtonCss,
								textDecoration: 'none',
								...(statusFilter === option.value
									? {
											borderColor: colors.primary,
											backgroundColor: colors.primarySoftest,
										}
									: {}),
							})}
						>
							{option.label}
						</a>
					))}
				</div>

				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading community reports…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}

				<div mix={css({ display: 'grid', gap: spacing.lg })}>
					{status === 'ready' && reports.length === 0 ? (
						<p mix={css(descriptionCss)}>No reports in this view.</p>
					) : null}
					{status === 'ready' && currentHref === lastLoadedHref
						? reports.map((report) => (
								<article key={report.id} mix={css(cardCss)}>
									<h2
										mix={css({
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
										})}
									>
										<a
											href={`/community/${report.listingId}`}
											mix={css({
												color: colors.primaryText,
												textDecoration: 'none',
											})}
										>
											{report.listingName}
										</a>
									</h2>
									<p mix={css(descriptionCss)}>
										<strong>Status:</strong> {report.status}
									</p>
									<p mix={css(descriptionCss)}>
										<strong>Reporter:</strong>{' '}
										<code>{report.reporterUserId}</code>
									</p>
									<p mix={css(descriptionCss)}>
										<strong>Owner:</strong>{' '}
										<code>{report.listingOwnerUserId}</code>
									</p>
									<p mix={css(descriptionCss)}>
										<strong>Created:</strong>{' '}
										{formatTimestamp(report.createdAt)}
									</p>
									<p mix={css(descriptionCss)}>{report.reason}</p>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Moderation note</span>
										<input
											value={getNote(report.id)}
											disabled={isMutating}
											placeholder="Optional note for dismiss, delist, delete, or ban"
											mix={[
												css(inputCss),
												on('input', (event) => {
													setNote(
														report.id,
														(event.target as HTMLInputElement).value,
													)
												}),
											]}
										/>
									</label>

									<div
										mix={css({
											display: 'flex',
											gap: spacing.sm,
											flexWrap: 'wrap',
										})}
									>
										<button
											disabled={isMutating}
											mix={[
												on(
													'click',
													() => void submitReportAction(report.id, 'dismiss'),
												),
												css(secondaryButtonCss),
											]}
										>
											Dismiss
										</button>
										<button
											disabled={isMutating}
											mix={[
												...getDestructiveButtonMix(report.id, 'delist', () => {
													void submitReportAction(report.id, 'delist')
												}),
												css(dangerButtonCss),
											]}
										>
											{isDoubleCheckActive(report.id, 'delist')
												? 'Confirm delist'
												: 'Delist'}
										</button>
										<button
											disabled={isMutating}
											mix={[
												...getDestructiveButtonMix(report.id, 'delete', () => {
													void submitReportAction(report.id, 'delete')
												}),
												css(dangerButtonCss),
											]}
										>
											{isDoubleCheckActive(report.id, 'delete')
												? 'Confirm delete'
												: 'Delete'}
										</button>
										<button
											disabled={isMutating}
											mix={[
												...getDestructiveButtonMix(
													report.id,
													'ban_reporter',
													() => {
														void submitReportAction(report.id, 'ban_reporter')
													},
												),
												css(dangerButtonCss),
											]}
										>
											{isDoubleCheckActive(report.id, 'ban_reporter')
												? 'Confirm ban reporter'
												: 'Ban reporter'}
										</button>
										<button
											disabled={isMutating}
											mix={[
												...getDestructiveButtonMix(
													report.id,
													'ban_reportee',
													() => {
														void submitReportAction(report.id, 'ban_reportee')
													},
												),
												css(dangerButtonCss),
											]}
										>
											{isDoubleCheckActive(report.id, 'ban_reportee')
												? 'Confirm ban owner'
												: 'Ban owner'}
										</button>
									</div>
								</article>
							))
						: null}
				</div>
			</AccountManagementShell>
		)
	}
}
