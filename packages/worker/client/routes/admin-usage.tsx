import { type Handle, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { readRouterSearch } from '#client/router-location.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import { cardCss } from '#client/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	MetadataGrid,
	accountManagementTableCellCss,
	accountManagementTableCss,
	accountManagementTableNumericCellCss,
	noticeCardCss,
} from './account-management-components.tsx'
import {
	type AdminUsageLoaderData,
	type AdminUsageRollup,
	type AdminUsageUserSummary,
} from '#app/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type PageStatus = 'loading' | 'ready' | 'error'

const adminUsageApiPath = '/admin/usage.json'

const usageMetricLabels = {
	execute: 'Executes',
	package_export: 'Package runs',
	job_run: 'Job runs',
	workflow_run: 'Workflow runs',
	service_runtime: 'Service runtime',
	outbound_fetch: 'Fetches',
	email_send: 'Email sends',
	email_received: 'Email receives',
} as const

function isAdminUsagePath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/usage'
}

function formatInteger(value: number) {
	return new Intl.NumberFormat().format(value)
}

function formatDuration(ms: number) {
	if (ms <= 0) return '0s'
	const seconds = ms / 1000
	if (seconds < 60) return `${seconds.toFixed(1)}s`
	const minutes = seconds / 60
	if (minutes < 60) return `${minutes.toFixed(1)}m`
	return `${(minutes / 60).toFixed(1)}h`
}

function formatPercent(value: number | null) {
	if (value === null) return 'Unlimited'
	return `${Math.round(value * 100)}%`
}

function formatLimit(limit: number | null) {
	return limit === null ? 'Unlimited' : formatInteger(limit)
}

function getMetric(
	usage: Array<AdminUsageRollup>,
	metric: AdminUsageRollup['metric'],
) {
	return usage.find((item) => item.metric === metric)
}

function usageHrefForUser(user: AdminUsageUserSummary) {
	return `/admin/usage?userId=${user.id}`
}

export async function adminUsageRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${adminUsageApiPath}${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view admin usage.')
	}
	const payload = await readJson<AdminUsageLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load admin usage.')
	}
	return { adminUsage: payload }
}

export function AdminUsageRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let data: AdminUsageLoaderData | null = null
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null

	function applyData(payload: AdminUsageLoaderData, href: string) {
		data = payload
		status = 'ready'
		message = null
		lastLoadedHref = href
		lastFailedHref = null
	}

	async function loadAdminUsage() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(
				`${adminUsageApiPath}${readRouterSearch(handle)}`,
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
				message = 'You do not have permission to view admin usage.'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminUsageLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin usage.')
			}
			applyData(payload, href)
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error ? error.message : 'Unable to load admin usage.'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isAdminUsagePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'adminUsage', href)
		if (!routeData) return false
		applyData(routeData, href)
		return true
	}

	const tableCss = accountManagementTableCss
	const cellCss = accountManagementTableCellCss
	const numericCellCss = accountManagementTableNumericCellCss

	let lastSeenHref = ''

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		if (currentHref !== lastSeenHref) {
			lastSeenHref = currentHref
			lastFailedHref = null
		}

		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad =
			(status === 'loading' ||
				currentHref !== lastLoadedHref ||
				needsStaleRefresh) &&
			currentHref !== lastFailedHref &&
			loadingForHref !== currentHref
		if (!appliedRouteData && needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			loadingForHref = currentHref
			handle.queueTask(loadAdminUsage)
		}

		const selectedUser = data?.selectedUser ?? null
		const totalPages = data
			? Math.max(1, Math.ceil(data.total / data.pageSize))
			: 1

		return (
			<AccountManagementShell maxWidth="min(100%, 92rem)">
				<AdminPageHeader
					title="Admin usage"
					description="Read-only account metadata for usage, quota counters, and resource counts. User content is never shown."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading usage…
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
						<AccountManagementPanel
							title={`Current month usage (${data.currentMonth})`}
							description="Counts come from usage_rollups; live resource counts use the entitlement counters."
						>
							<div mix={css({ overflowX: 'auto' })}>
								<table mix={css(tableCss)}>
									<thead>
										<tr>
											<th mix={css(cellCss)}>Account</th>
											<th mix={css(cellCss)}>Plan</th>
											<th mix={css(numericCellCss)}>Executes</th>
											<th mix={css(numericCellCss)}>Package runs</th>
											<th mix={css(numericCellCss)}>Job runs</th>
											<th mix={css(numericCellCss)}>Workflow runs</th>
											<th mix={css(numericCellCss)}>Service runtime</th>
											<th mix={css(numericCellCss)}>Fetches</th>
											<th mix={css(numericCellCss)}>Email sends</th>
											<th mix={css(numericCellCss)}>Email today</th>
											<th mix={css(cellCss)}>Live resources</th>
										</tr>
									</thead>
									<tbody>
										{data.users.map((user) => {
											const execute = getMetric(
												user.currentMonthUsage,
												'execute',
											)
											const packageExport = getMetric(
												user.currentMonthUsage,
												'package_export',
											)
											const jobRun = getMetric(
												user.currentMonthUsage,
												'job_run',
											)
											const workflowRun = getMetric(
												user.currentMonthUsage,
												'workflow_run',
											)
											const serviceRuntime = getMetric(
												user.currentMonthUsage,
												'service_runtime',
											)
											const outboundFetch = getMetric(
												user.currentMonthUsage,
												'outbound_fetch',
											)
											const emailSend = getMetric(
												user.currentMonthUsage,
												'email_send',
											)
											const emailToday =
												user.todayCounters.find(
													(counter) =>
														counter.resource === 'email_sends_per_day',
												)?.count ?? 0
											return (
												<tr key={user.id}>
													<td mix={css(cellCss)}>
														<a href={usageHrefForUser(user)}>
															<strong>{user.username}</strong>
														</a>
														<br />
														<span
															mix={css({
																color: colors.textMuted,
																fontSize: typography.fontSize.xs,
															})}
														>
															{user.email}
														</span>
													</td>
													<td mix={css(cellCss)}>
														{user.plan ?? 'Legacy/unlimited'}
													</td>
													<td mix={css(numericCellCss)}>
														{formatInteger(execute?.eventCount ?? 0)}
													</td>
													<td mix={css(numericCellCss)}>
														{formatInteger(packageExport?.eventCount ?? 0)}
													</td>
													<td mix={css(numericCellCss)}>
														{formatInteger(jobRun?.eventCount ?? 0)}
													</td>
													<td mix={css(numericCellCss)}>
														{formatInteger(workflowRun?.eventCount ?? 0)}
													</td>
													<td mix={css(numericCellCss)}>
														{formatDuration(
															serviceRuntime?.totalDurationMs ?? 0,
														)}
													</td>
													<td mix={css(numericCellCss)}>
														{formatInteger(outboundFetch?.eventCount ?? 0)}
													</td>
													<td mix={css(numericCellCss)}>
														{formatInteger(emailSend?.eventCount ?? 0)}
													</td>
													<td mix={css(numericCellCss)}>
														{formatInteger(emailToday)}
													</td>
													<td mix={css(cellCss)}>
														{user.resourceCounts.map((resource) => (
															<span
																key={resource.resource}
																mix={css({
																	display: 'inline-block',
																	marginRight: spacing.sm,
																	whiteSpace: 'nowrap',
																})}
															>
																{resource.label}:{' '}
																<strong>
																	{formatInteger(resource.current)}
																</strong>
															</span>
														))}
													</td>
												</tr>
											)
										})}
									</tbody>
								</table>
							</div>
							{data.users.length === 0 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									No users found.
								</p>
							) : null}
							{totalPages > 1 ? (
								<p mix={css({ margin: 0, color: colors.textMuted })}>
									Page {data.page} of {totalPages}
								</p>
							) : null}
						</AccountManagementPanel>

						{selectedUser ? (
							<AccountManagementPanel
								title={`Usage drill-down: ${selectedUser.username}`}
								description="Plan limits are compared to current consumption; warnings appear above 80% of a numeric limit."
							>
								<MetadataGrid
									columns={3}
									items={[
										{ label: 'Email', value: selectedUser.email },
										{
											label: 'Plan',
											value: selectedUser.plan ?? 'Legacy/unlimited',
										},
										{
											label: 'Warnings',
											value:
												selectedUser.warnings.length > 0
													? `${selectedUser.warnings.length} over 80%`
													: 'None',
										},
									]}
								/>
								{selectedUser.warnings.length > 0 ? (
									<div mix={css(noticeCardCss)}>
										<strong>Quota watch:</strong>{' '}
										{selectedUser.warnings
											.map(
												(item) =>
													`${item.label} at ${formatPercent(item.percentOfLimit)}`,
											)
											.join(', ')}
									</div>
								) : null}
								<div
									mix={css({
										display: 'grid',
										gap: spacing.lg,
										gridTemplateColumns:
											'repeat(auto-fit, minmax(min(24rem, 100%), 1fr))',
									})}
								>
									<section mix={css(cardCss)}>
										<h3
											mix={css({
												margin: 0,
												fontSize: typography.fontSize.base,
											})}
										>
											Entitlements
										</h3>
										<div mix={css({ overflowX: 'auto' })}>
											<table mix={css(tableCss)}>
												<thead>
													<tr>
														<th mix={css(cellCss)}>Resource</th>
														<th mix={css(numericCellCss)}>Current</th>
														<th mix={css(numericCellCss)}>Limit</th>
														<th mix={css(numericCellCss)}>Used</th>
													</tr>
												</thead>
												<tbody>
													{selectedUser.entitlementConsumption.map((item) => (
														<tr key={item.resource}>
															<td mix={css(cellCss)}>{item.label}</td>
															<td mix={css(numericCellCss)}>
																{item.current === null
																	? 'Not measured'
																	: formatInteger(item.current)}
															</td>
															<td mix={css(numericCellCss)}>
																{formatLimit(item.limit)}
															</td>
															<td mix={css(numericCellCss)}>
																{formatPercent(item.percentOfLimit)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</section>
									<section mix={css(cardCss)}>
										<h3
											mix={css({
												margin: 0,
												fontSize: typography.fontSize.base,
											})}
										>
											Month-over-month usage
										</h3>
										<div mix={css({ overflowX: 'auto' })}>
											<table mix={css(tableCss)}>
												<thead>
													<tr>
														<th mix={css(cellCss)}>Month</th>
														{Object.values(usageMetricLabels).map((label) => (
															<th key={label} mix={css(numericCellCss)}>
																{label}
															</th>
														))}
													</tr>
												</thead>
												<tbody>
													{selectedUser.monthUsage.map((month) => (
														<tr key={month.month}>
															<td mix={css(cellCss)}>{month.month}</td>
															{Object.keys(usageMetricLabels).map((metric) => (
																<td key={metric} mix={css(numericCellCss)}>
																	{formatInteger(
																		getMetric(
																			month.usage,
																			metric as AdminUsageRollup['metric'],
																		)?.eventCount ?? 0,
																	)}
																</td>
															))}
														</tr>
													))}
												</tbody>
											</table>
										</div>
									</section>
								</div>
							</AccountManagementPanel>
						) : null}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
