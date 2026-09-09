import { formatTimestamp } from '#client/format-timestamp.ts'
import { type Handle, css } from 'remix/ui'
import { on } from '#client/event-mixin.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementInlineLinkNav,
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
	IdValue,
	accountInputCss,
} from './account-management-components.tsx'
import { type AdminCommunityReportsLoaderData } from '#universal/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

/**
 * `IdValue` is a flex row (value plus copy control), so the label beside it
 * needs a flex line of its own rather than the default text flow.
 */
const idLineCss = {
	...descriptionCss,
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: spacing.xs,
}

type AdminCommunityReportListItem =
	AdminCommunityReportsLoaderData['reports'][number]

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

function buildReportsHref(handle: Handle, status: string) {
	const url = new URL(readCurrentRouterHref(handle), 'http://localhost')
	if (status === 'open') url.searchParams.delete('status')
	else url.searchParams.set('status', status)
	return `${url.pathname}${url.search}`
}

export async function adminCommunityReportsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${adminCommunityReportsApiPath}${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view community reports.')
	}
	const payload = await readJson<AdminCommunityReportsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load community reports.')
	}
	return { adminCommunityReports: payload }
}

export function AdminCommunityReportsRoute(handle: Handle) {
	let reports: Array<AdminCommunityReportListItem> = []
	let statusFilter = 'open'
	let message: string | null = null
	let actionState: 'idle' | 'acting' = 'idle'
	let noteByReportId = new Map<string, string>()
	let pendingDoubleCheckKey: string | null = null
	/** Payload last applied to the closure state above. */
	let appliedPayload: AdminCommunityReportsLoaderData | null = null
	let appliedError: Error | null = null
	const reportsData = createRouteData({
		key: 'adminCommunityReports',
		async load(href, signal) {
			const response = await fetch(
				`${adminCommunityReportsApiPath}${new URL(href, 'http://localhost').search}`,
				{
					headers: { Accept: 'application/json' },
					credentials: 'include',
					signal,
				},
			)
			if (response.status === 401) return routeDataRedirect('/login')
			if (response.status === 403) {
				throw new Error('You do not have permission to view community reports.')
			}
			const payload = await readJson<AdminCommunityReportsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load community reports.')
			}
			return payload
		},
	})

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
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{ ok: boolean; error?: string }>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to complete action.')
			}
			actionState = 'idle'
			reportsData.reload(handle, readCurrentRouterHref(handle))
		} catch (error) {
			actionState = 'idle'
			message =
				error instanceof Error ? error.message : 'Unable to complete action.'
			handle.update()
		}
	}

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const isMutating = actionState !== 'idle'
		const snapshot = reportsData.read(handle, currentHref)
		if (snapshot.data && snapshot.data !== appliedPayload) {
			appliedPayload = snapshot.data
			reports = snapshot.data.reports
			statusFilter = snapshot.data.statusFilter
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

		return (
			<AccountManagementShell busy={pending && appliedPayload !== null}>
				<AdminPageHeader
					title="Community reports"
					description="Review open reports and moderate community listings."
					currentHref={currentHref}
				/>

				<AccountManagementInlineLinkNav
					label="Report status"
					items={statusOptions.map((option) => ({
						href: buildReportsHref(handle, option.value),
						label: option.label,
						active: statusFilter === option.value,
					}))}
				/>

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
					{status === 'ready'
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
									<p mix={css(idLineCss)}>
										<strong>Reporter:</strong>
										<IdValue
											value={report.reporterUserId}
											label="reporter user id"
										/>
									</p>
									<p mix={css(idLineCss)}>
										<strong>Owner:</strong>
										<IdValue
											value={report.listingOwnerUserId}
											label="listing owner user id"
										/>
									</p>
									<p mix={css(descriptionCss)}>
										<strong>Created:</strong>{' '}
										{formatTimestamp(report.createdAt)}
									</p>
									<p mix={css(descriptionCss)}>{report.reason}</p>

									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Moderation note</span>
										<input
											data-field-ring
											value={getNote(report.id)}
											disabled={isMutating}
											placeholder="Optional note for dismiss, delist, delete, or ban"
											mix={[
												css(accountInputCss),
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
