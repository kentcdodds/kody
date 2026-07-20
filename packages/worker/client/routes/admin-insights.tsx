import { css, type Handle } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, mq, spacing, typography } from '#client/styles/tokens.ts'
import { cardCss } from '#client/styles/style-primitives.ts'
import { AreaChart } from '#client/charts/area-chart.tsx'
import { ChartLegend } from '#client/charts/chart-legend.tsx'
import { DonutChart } from '#client/charts/donut-chart.tsx'
import { HeatmapChart } from '#client/charts/heatmap-chart.tsx'
import { StackedBarChart } from '#client/charts/stacked-bar-chart.tsx'
import { StatCard } from '#client/charts/stat-card.tsx'
import {
	chartColor,
	formatCompactNumber,
	formatIntegerNumber,
	formatPercentShare,
} from '#client/charts/chart-theme.ts'
import {
	formatMonthKeyLabel,
	monthShortNames,
	usageMetricSeries,
} from '#client/charts/usage-metric-series.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { type AdminInsightsLoaderData } from '#app/loader-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'

type PageStatus = 'loading' | 'ready' | 'error'

const adminInsightsApiPath = '/admin/insights.json'

const planColors: Record<string, string> = {
	pro: chartColor.violet,
	free: chartColor.blue,
	partner: chartColor.emerald,
	none: chartColor.cyan,
}

const workflowStatusColors: Record<string, string> = {
	complete: chartColor.emerald,
	completed: chartColor.emerald,
	running: chartColor.blue,
	queued: chartColor.cyan,
	waiting: chartColor.amber,
	paused: chartColor.amber,
	errored: chartColor.rose,
	failed: chartColor.rose,
	terminated: chartColor.fuchsia,
	unknown: chartColor.lime,
}

const authCategoryColors: Record<string, string> = {
	auth: chartColor.blue,
	account: chartColor.emerald,
	admin: chartColor.amber,
	oauth: chartColor.violet,
}

function isAdminInsightsPath(href: string) {
	return new URL(href, 'http://localhost').pathname === '/admin/insights'
}

/** `2026-06-29` -> `Jun 29` */
function formatDayLabel(dayKey: string) {
	const monthIndex = Number(dayKey.slice(5, 7)) - 1
	const dayOfMonth = Number(dayKey.slice(8, 10))
	return `${monthShortNames[monthIndex] ?? '?'} ${dayOfMonth}`
}

function formatPlanLabel(plan: string) {
	return plan === 'none' ? 'No plan' : plan
}

export async function adminInsightsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(`${adminInsightsApiPath}${url.search}`, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 403) {
		throw new Error('You do not have permission to view admin insights.')
	}
	const payload = await readJson<AdminInsightsLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load admin insights.')
	}
	return { adminInsights: payload }
}

type ChartCardProps = {
	title: string
	sub?: string
	/** Grid column span on wide screens out of 12. */
	span?: 4 | 6 | 8 | 12
	legend?: any
	children: any
}

function ChartCard(handle: Handle<ChartCardProps>) {
	return () => (
		<section
			aria-label={handle.props.title}
			mix={css({
				...cardCss,
				gridColumn: `span ${handle.props.span ?? 12}`,
				alignContent: 'start',
				minWidth: 0,
				[mq.tablet]: { gridColumn: 'span 12' },
			})}
		>
			<div mix={css({ display: 'grid', gap: spacing.xs })}>
				<h2
					mix={css({
						margin: 0,
						fontSize: typography.fontSize.base,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					})}
				>
					{handle.props.title}
				</h2>
				{handle.props.sub ? (
					<p
						mix={css({
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						})}
					>
						{handle.props.sub}
					</p>
				) : null}
			</div>
			{handle.props.legend ?? null}
			{handle.props.children}
		</section>
	)
}

export function AdminInsightsRoute(handle: Handle) {
	let status: PageStatus = 'loading'
	let data: AdminInsightsLoaderData | null = null
	let message: string | null = null
	let loadRequestId = 0
	let lastLoadedHref = ''
	let loadingForHref: string | null = null
	let lastFailedHref: string | null = null

	function applyData(payload: AdminInsightsLoaderData, href: string) {
		data = payload
		status = 'ready'
		message = null
		lastLoadedHref = href
		lastFailedHref = null
	}

	async function loadAdminInsights() {
		const href = readCurrentRouterHref(handle)
		loadingForHref = href
		const requestId = ++loadRequestId
		try {
			const response = await fetch(adminInsightsApiPath, {
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
				message = 'You do not have permission to view admin insights.'
				lastFailedHref = href
				handle.update()
				return
			}
			const payload = await readJson<AdminInsightsLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load admin insights.')
			}
			applyData(payload, href)
			handle.update()
		} catch (error) {
			if (requestId !== loadRequestId) return
			status = 'error'
			message =
				error instanceof Error
					? error.message
					: 'Unable to load admin insights.'
			lastFailedHref = href
			handle.update()
		} finally {
			if (requestId === loadRequestId) loadingForHref = null
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isAdminInsightsPath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'adminInsights', href)
		if (!routeData) return false
		applyData(routeData, href)
		return true
	}

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
			handle.queueTask(loadAdminInsights)
		}

		return (
			<AccountManagementShell maxWidth="min(100%, 92rem)">
				<AdminPageHeader
					title="Admin insights"
					description="Platform-wide activity at a glance. Aggregated account metadata only — user content is never shown."
					currentHref={currentHref}
				/>
				{status === 'loading' ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading insights…
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage
						tone={status === 'error' ? 'error' : 'info'}
					>
						{message}
					</AccountManagementMessage>
				) : null}
				{data ? renderDashboard(data) : null}
			</AccountManagementShell>
		)
	}
}

function renderDashboard(data: AdminInsightsLoaderData) {
	const signupWeeks = data.signupsByWeek
	const latestWeek = signupWeeks[signupWeeks.length - 1]
	const weekLabels = signupWeeks.map((week) => formatDayLabel(week.weekStart))
	const monthLabels = data.usageByMonth.map((month) =>
		formatMonthKeyLabel(month.month),
	)
	const dayLabels = data.emailByDay.map((day) => formatDayLabel(day.day))
	const authDayLabels = data.authByDay.map((day) => formatDayLabel(day.day))
	const totalAuthEvents = data.authByCategory.reduce(
		(sum, entry) => sum + entry.count,
		0,
	)
	const totalJobRuns = data.jobHealth.successRuns + data.jobHealth.errorRuns
	const emailWindowTotal = data.emailByDay.reduce(
		(sum, day) => sum + day.sends + day.receives,
		0,
	)
	const verifiedShare =
		data.totals.users > 0 ? data.totals.verifiedUsers / data.totals.users : 0

	return (
		<>
			<div
				mix={css({
					display: 'grid',
					gap: spacing.md,
					gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
					[mq.tablet]: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
					[mq.mobile]: { gridTemplateColumns: 'minmax(0, 1fr)' },
				})}
			>
				<StatCard
					id="stat-users"
					label="Users"
					value={formatIntegerNumber(data.totals.users)}
					sub={`${formatPercentShare(verifiedShare)} verified · +${formatIntegerNumber(latestWeek?.signups ?? 0)} this week`}
					color={chartColor.blue}
					sparkValues={signupWeeks.map((week) => week.cumulativeUsers)}
				/>
				<StatCard
					id="stat-packages"
					label="Saved packages"
					value={formatIntegerNumber(data.totals.savedPackages)}
					sub={`${formatIntegerNumber(data.totals.activeCommunityListings)} community listings`}
					color={chartColor.emerald}
				/>
				<StatCard
					id="stat-jobs"
					label="Scheduled jobs"
					value={formatIntegerNumber(data.totals.scheduledJobs)}
					sub={`${formatIntegerNumber(data.totals.enabledJobs)} enabled · ${formatIntegerNumber(totalJobRuns)} runs recorded`}
					color={chartColor.amber}
				/>
				<StatCard
					id="stat-workflows"
					label="Workflow runs"
					value={formatIntegerNumber(data.totals.workflowRuns)}
					sub="All-time durable runs"
					color={chartColor.violet}
				/>
				<StatCard
					id="stat-memories"
					label="Active memories"
					value={formatIntegerNumber(data.totals.activeMemories)}
					sub="Long-term assistant memory"
					color={chartColor.rose}
				/>
				<StatCard
					id="stat-email"
					label="Stored emails"
					value={formatIntegerNumber(data.totals.storedEmailMessages)}
					sub={`${formatCompactNumber(emailWindowTotal)} sent + received in 28 days`}
					color={chartColor.cyan}
					sparkValues={data.emailByDay.map((day) => day.sends + day.receives)}
				/>
				<StatCard
					id="stat-secrets"
					label="Secrets"
					value={formatIntegerNumber(data.totals.secrets)}
					sub="Encrypted references (values never shown)"
					color={chartColor.lime}
				/>
				<StatCard
					id="stat-signin"
					label="Sign-in methods"
					value={formatIntegerNumber(
						data.totals.passkeys + data.totals.oauthConnections,
					)}
					sub={`${formatIntegerNumber(data.totals.passkeys)} passkeys · ${formatIntegerNumber(data.totals.oauthConnections)} social links`}
					color={chartColor.fuchsia}
				/>
			</div>

			<div
				mix={css({
					display: 'grid',
					gap: spacing.lg,
					gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
					[mq.tablet]: { gridTemplateColumns: 'minmax(0, 1fr)' },
				})}
			>
				<ChartCard
					title="User growth"
					sub="Cumulative registered users over the last 12 weeks."
					span={8}
				>
					<AreaChart
						id="growth"
						ariaLabel="Cumulative registered users per week"
						series={[
							{
								label: 'Total users',
								color: chartColor.blue,
								values: signupWeeks.map((week) => week.cumulativeUsers),
							},
						]}
						xLabels={weekLabels}
					/>
				</ChartCard>
				<ChartCard title="New signups" sub="Fresh accounts per week." span={4}>
					<StackedBarChart
						id="signups"
						ariaLabel="New signups per week"
						series={[
							{
								label: 'Signups',
								color: chartColor.emerald,
								values: signupWeeks.map((week) => week.signups),
							},
						]}
						xLabels={weekLabels}
						xTickEvery={3}
						viewBoxWidth={360}
					/>
				</ChartCard>

				<ChartCard
					title="Platform activity"
					sub="Metered events across all accounts by month, from the usage rollups."
					span={12}
					legend={
						<ChartLegend
							items={usageMetricSeries.map((entry) => ({
								label: entry.label,
								color: entry.color,
							}))}
						/>
					}
				>
					<StackedBarChart
						id="activity"
						ariaLabel="Metered platform events by month"
						series={usageMetricSeries.map((entry) => ({
							label: entry.label,
							color: entry.color,
							values: data.usageByMonth.map(
								(month) => month.events[entry.metric] ?? 0,
							),
						}))}
						xLabels={monthLabels}
						xTickEvery={1}
					/>
				</ChartCard>

				<ChartCard
					title="Email traffic"
					sub="Daily sends and receives across every inbox, last 28 days."
					span={8}
					legend={
						<ChartLegend
							items={[
								{ label: 'Sends', color: chartColor.cyan },
								{ label: 'Receives', color: chartColor.violet },
							]}
						/>
					}
				>
					<AreaChart
						id="email"
						ariaLabel="Email sends and receives per day"
						series={[
							{
								label: 'Sends',
								color: chartColor.cyan,
								values: data.emailByDay.map((day) => day.sends),
							},
							{
								label: 'Receives',
								color: chartColor.violet,
								values: data.emailByDay.map((day) => day.receives),
							},
						]}
						xLabels={dayLabels}
					/>
				</ChartCard>
				<ChartCard
					title="Users by plan"
					sub="Current plan distribution."
					span={4}
				>
					<DonutChart
						ariaLabel="Users by plan"
						centerLabel="users"
						slices={data.plans.map((slice, index) => ({
							label: formatPlanLabel(slice.plan),
							value: slice.count,
							color:
								planColors[slice.plan] ??
								[chartColor.amber, chartColor.rose, chartColor.lime][
									index % 3
								] ??
								chartColor.amber,
						}))}
					/>
				</ChartCard>

				<ChartCard
					title="Auth pulse"
					sub="Authentication and account events per day, last 28 days."
					span={8}
					legend={
						<ChartLegend
							items={[
								{ label: 'Success', color: chartColor.emerald },
								{ label: 'Failure', color: chartColor.rose },
								{ label: 'Rate limited', color: chartColor.amber },
							]}
						/>
					}
				>
					<StackedBarChart
						id="auth"
						ariaLabel="Audit events per day by result"
						series={[
							{
								label: 'Success',
								color: chartColor.emerald,
								values: data.authByDay.map((day) => day.success),
							},
							{
								label: 'Failure',
								color: chartColor.rose,
								values: data.authByDay.map((day) => day.failure),
							},
							{
								label: 'Rate limited',
								color: chartColor.amber,
								values: data.authByDay.map((day) => day.rateLimited),
							},
						]}
						xLabels={authDayLabels}
					/>
				</ChartCard>
				<ChartCard
					title="Event categories"
					sub={`${formatIntegerNumber(totalAuthEvents)} audit events in 28 days.`}
					span={4}
				>
					<DonutChart
						ariaLabel="Audit events by category"
						centerLabel="events"
						slices={data.authByCategory.map((entry, index) => ({
							label: entry.category,
							value: entry.count,
							color:
								authCategoryColors[entry.category] ??
								[chartColor.cyan, chartColor.lime][index % 2] ??
								chartColor.cyan,
						}))}
					/>
				</ChartCard>

				<ChartCard
					title="When things happen"
					sub="Audit event activity by weekday and hour (UTC), last 28 days."
					span={8}
				>
					<HeatmapChart
						ariaLabel="Audit events by weekday and hour"
						cells={data.authHeatmap}
						color={chartColor.blue}
						unitLabel="events"
					/>
				</ChartCard>
				<ChartCard
					title="Workflow outcomes"
					sub="All durable workflow runs by status."
					span={4}
				>
					<DonutChart
						ariaLabel="Workflow runs by status"
						centerLabel="runs"
						slices={data.workflowStatuses.map((entry, index) => ({
							label: entry.status,
							value: entry.count,
							color:
								workflowStatusColors[entry.status] ??
								[chartColor.cyan, chartColor.lime, chartColor.fuchsia][
									index % 3
								] ??
								chartColor.cyan,
						}))}
					/>
				</ChartCard>

				<ChartCard
					title="Job run health"
					sub={`${formatIntegerNumber(data.jobHealth.enabledJobs)} of ${formatIntegerNumber(data.jobHealth.totalJobs)} scheduled jobs enabled.`}
					span={6}
				>
					<DonutChart
						ariaLabel="Job runs by outcome"
						centerLabel="job runs"
						emptyText="No job runs recorded yet."
						slices={[
							{
								label: 'Succeeded',
								value: data.jobHealth.successRuns,
								color: chartColor.emerald,
							},
							{
								label: 'Failed',
								value: data.jobHealth.errorRuns,
								color: chartColor.rose,
							},
						]}
					/>
				</ChartCard>
				<ChartCard
					title="Email verification"
					sub="Verified versus unverified accounts."
					span={6}
				>
					<DonutChart
						ariaLabel="Users by email verification"
						centerLabel="users"
						slices={[
							{
								label: 'Verified',
								value: data.totals.verifiedUsers,
								color: chartColor.blue,
							},
							{
								label: 'Unverified',
								value: data.totals.users - data.totals.verifiedUsers,
								color: chartColor.amber,
							},
						]}
					/>
				</ChartCard>
			</div>
		</>
	)
}
