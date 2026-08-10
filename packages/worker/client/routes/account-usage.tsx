import { type Handle, css } from 'remix/ui'
import { adminGrantDiffersFromSubscription } from '#universal/account-plan-display.ts'
import {
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
	type AdminPlanName,
} from '#universal/loader-data.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	type AccountStatus,
	readJson,
} from '#client/routes/account-approval-shared.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from '#client/routes/account-management-components.tsx'
import { RecordTable } from '#client/routes/record-table.tsx'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'

const usageApiPath = '/account/usage.json'
const usagePath = '/account/usage'
const billingPath = '/account/billing'

const entitlementGroupOrder: Array<
	AccountUsageEntitlementConsumption['group']
> = ['daily', 'counts', 'storage', 'limits']

const entitlementGroupLabels: Record<
	AccountUsageEntitlementConsumption['group'],
	string
> = {
	daily: 'Daily rates',
	counts: 'Resource counts',
	storage: 'Storage',
	limits: 'Per-item limits',
}

const entitlementGroupNotes: Partial<
	Record<AccountUsageEntitlementConsumption['group'], string>
> = {
	daily: 'Counters reset at UTC midnight.',
}

function formatUsagePercent(value: number | null) {
	if (value === null) return '—'
	return `${Math.round(value * 100)}%`
}

function formatPlanLabel(plan: AdminPlanName) {
	return plan.charAt(0).toUpperCase() + plan.slice(1)
}

function formatBytes(value: number) {
	if (value < 1024) return `${value} B`
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
	if (value < 1024 * 1024 * 1024) {
		return `${(value / (1024 * 1024)).toFixed(1)} MiB`
	}
	return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

function formatUsageValue(resource: string, value: number) {
	if (resource === 'storage_bytes' || resource === 'email_message_bytes') {
		return formatBytes(value)
	}
	return formatIntegerNumber(value)
}

function formatCurrentValue(item: AccountUsageEntitlementConsumption) {
	if (item.kind === 'per_unit_max') return '—'
	return formatUsageValue(item.resource, item.current)
}

function formatLimitValue(item: AccountUsageEntitlementConsumption) {
	return formatUsageValue(item.resource, item.limit)
}

function usageProgressPercent(item: AccountUsageEntitlementConsumption) {
	if (item.percentOfLimit === null) return null
	return Math.min(100, Math.round(item.percentOfLimit * 100))
}

function isUsagePath(href: string) {
	return new URL(href, 'http://localhost').pathname === usagePath
}

function groupEntitlementRows(rows: Array<AccountUsageEntitlementConsumption>) {
	const grouped = new Map<
		AccountUsageEntitlementConsumption['group'],
		Array<AccountUsageEntitlementConsumption>
	>()
	for (const group of entitlementGroupOrder) grouped.set(group, [])
	for (const row of rows) {
		const bucket = grouped.get(row.group) ?? []
		bucket.push(row)
		grouped.set(row.group, bucket)
	}
	return entitlementGroupOrder
		.map((group) => ({
			group,
			rows: grouped.get(group) ?? [],
		}))
		.filter((entry) => entry.rows.length > 0)
}

function renderUsageProgressBar(item: AccountUsageEntitlementConsumption) {
	const percent = usageProgressPercent(item)
	if (percent === null) return null
	const barColor = item.overEightyPercent ? chartColor.amber : chartColor.blue
	return (
		<div
			role="img"
			aria-label={`${item.label}: ${formatUsagePercent(item.percentOfLimit)} of plan limit`}
			mix={css({
				height: '8px',
				borderRadius: radius.md,
				background: colors.border,
				overflow: 'hidden',
				minWidth: '4rem',
			})}
		>
			<div
				mix={css({
					height: '100%',
					width: `${percent}%`,
					background: barColor,
				})}
			/>
		</div>
	)
}

export async function accountUsageRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const response = await fetch(usageApiPath, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	const payload = await readJson<AccountUsageLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load usage.')
	}
	return { accountUsage: payload }
}

export function AccountUsageRoute(handle: Handle) {
	let status: AccountStatus = 'loading'
	let data: AccountUsageLoaderData | null = null
	let message: string | null = null
	const loadLatch = createRouteLoadLatch()

	function applyPayload(payload: AccountUsageLoaderData) {
		data = payload
		status = 'ready'
		message = null
	}

	async function loadUsage(signal: AbortSignal) {
		const href = readCurrentRouterHref(handle)
		try {
			const response = await fetch(usageApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<AccountUsageLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load usage.')
			}
			applyPayload(payload)
			loadLatch.markLoaded(href)
			handle.update()
		} catch (error) {
			if (signal.aborted) return
			status = 'error'
			message = error instanceof Error ? error.message : 'Unable to load usage.'
			loadLatch.markFailed(href)
			handle.update()
		}
	}

	function applyRouteLoaderData(href: string) {
		if (!isUsagePath(href)) return false
		const routeData = tryConsumeRouteLoaderData(handle, 'accountUsage', href)
		if (!routeData) return false
		applyPayload(routeData)
		loadLatch.markLoaded(href)
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const appliedRouteData = applyRouteLoaderData(currentHref)
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedRouteData
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			isLoading: status === 'loading',
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			handle.queueTask(loadUsage)
		}

		const usage = status === 'ready' ? data : null
		const groupedRows = usage
			? groupEntitlementRows(usage.entitlementConsumption)
			: []

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Usage"
					description="Plan limits, current consumption, and what counts toward each resource."
					currentHref={currentHref}
				/>
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}
				{status === 'loading' ? (
					<p mix={css(descriptionCss)}>Loading usage…</p>
				) : null}
				{usage ? (
					<>
						<AccountManagementPanel title="Plan">
							<p
								mix={css({
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								Current plan: {formatPlanLabel(usage.plan)}
							</p>
							{adminGrantDiffersFromSubscription(
								usage.manualPlan,
								usage.stripePlan,
							) ? (
								<>
									<p mix={css(descriptionCss)}>
										Your effective plan is the higher of any admin grant and
										your Stripe subscription.
									</p>
									<MetadataGrid
										items={[
											{
												label: 'Granted plan',
												value: formatPlanLabel(usage.manualPlan),
											},
											{
												label: 'Subscription plan',
												value: usage.stripePlan
													? formatPlanLabel(usage.stripePlan)
													: 'None',
											},
										]}
									/>
								</>
							) : null}
							<p mix={css(descriptionCss)}>Usage day (UTC): {usage.today}</p>
							<p mix={css({ margin: 0 })}>
								<a href={billingPath} mix={css(primaryLinkCss)}>
									Manage billing
								</a>
							</p>
						</AccountManagementPanel>
						{usage.warnings.length > 0 ? (
							<AccountManagementPanel
								title="Approaching limits"
								description="These resources are above 80% of your plan limit."
							>
								<ul
									mix={css({
										margin: 0,
										paddingLeft: spacing.lg,
										display: 'grid',
										gap: spacing.sm,
										color: colors.text,
									})}
								>
									{usage.warnings.map((item) => (
										<li key={item.resource}>
											<strong>{item.label}</strong>: {formatCurrentValue(item)}{' '}
											/ {formatLimitValue(item)} (
											{formatUsagePercent(item.percentOfLimit)}).{' '}
											{item.howToReduce}{' '}
											<a href={billingPath} mix={css(primaryLinkCss)}>
												Upgrade your plan
											</a>
										</li>
									))}
								</ul>
							</AccountManagementPanel>
						) : null}
						{groupedRows.map(({ group, rows }) => (
							<AccountManagementPanel
								key={group}
								title={entitlementGroupLabels[group]}
								description={
									entitlementGroupNotes[group] ??
									'Current use compared to your plan limit.'
								}
							>
								<RecordTable
									mode="none"
									ariaLabel={`${entitlementGroupLabels[group]} usage`}
									// Each group is a handful of rows inside a panel that is
									// already part of a scrolling page; a nested scroller here
									// would only hide rows.
									scrollHeight="none"
									columns={[
										{ key: 'resource', label: 'Resource', primary: true },
										{ key: 'current', label: 'In use', align: 'end' },
										{ key: 'limit', label: 'Limit', align: 'end' },
										{ key: 'used', label: 'Used', align: 'end' },
										{ key: 'progress', label: 'Progress' },
									]}
									rows={rows.map((item) => ({
										id: item.resource,
										cells: {
											resource: (
												<span mix={css({ display: 'grid', gap: spacing.xs })}>
													<span
														mix={css({
															fontWeight: typography.fontWeight.medium,
															color: colors.text,
														})}
													>
														{item.label}
													</span>
													<span
														mix={css({
															fontSize: typography.fontSize.sm,
															color: colors.textMuted,
															lineHeight: 1.4,
															whiteSpace: 'normal',
														})}
													>
														{item.whatCounts} {item.howToReduce}
													</span>
												</span>
											),
											current: formatCurrentValue(item),
											limit: formatLimitValue(item),
											used: (
												<span
													mix={css(
														item.overEightyPercent
															? {
																	color: chartColor.amber,
																	fontWeight: typography.fontWeight.semibold,
																}
															: {},
													)}
												>
													{formatUsagePercent(item.percentOfLimit)}
												</span>
											),
											progress: renderUsageProgressBar(item),
										},
									}))}
								/>
							</AccountManagementPanel>
						))}
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
