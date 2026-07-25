import { type Handle, css } from 'remix/ui'
import {
	type AccountUsageLoaderData,
	type AdminPlanName,
} from '#app/loader-data.ts'
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
	accountManagementTableCellCss,
	accountManagementTableCss,
	accountManagementTableNumericCellCss,
} from '#client/routes/account-management-components.tsx'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	descriptionCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'

const usageApiPath = '/account/usage.json'
const usagePath = '/account/usage'

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
	if (resource === 'storage_bytes') return formatBytes(value)
	return formatIntegerNumber(value)
}

function isUsagePath(href: string) {
	return new URL(href, 'http://localhost').pathname === usagePath
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

		return (
			<AccountManagementShell>
				<AccountPageHeader
					title="Usage"
					description="Your current plan limits and how much you are using today."
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
						<AccountManagementPanel
							title="Plan"
							description="Effective plan after combining any granted plan with your Stripe subscription."
						>
							<MetadataGrid
								items={[
									{
										label: 'Effective plan',
										value: formatPlanLabel(usage.plan),
									},
									{ label: 'Usage day (UTC)', value: usage.today },
								]}
							/>
							<p mix={css({ margin: `${spacing.sm} 0 0` })}>
								<a href="/account/billing" mix={css(primaryLinkCss)}>
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
										gap: spacing.xs,
										color: colors.text,
									})}
								>
									{usage.warnings.map((item) => (
										<li key={item.resource}>
											{item.label}:{' '}
											{formatUsageValue(item.resource, item.current)} /{' '}
											{formatUsageValue(item.resource, item.limit)} (
											{formatUsagePercent(item.percentOfLimit)})
										</li>
									))}
								</ul>
							</AccountManagementPanel>
						) : null}
						<AccountManagementPanel
							title="Entitlement use"
							description="Row counts and daily counters enforced against your plan. Daily counters reset at UTC midnight."
						>
							<div mix={css({ overflowX: 'auto' })}>
								<table mix={css(accountManagementTableCss)}>
									<thead>
										<tr>
											<th mix={css(accountManagementTableCellCss)}>Resource</th>
											<th mix={css(accountManagementTableNumericCellCss)}>
												In use
											</th>
											<th mix={css(accountManagementTableNumericCellCss)}>
												Limit
											</th>
											<th mix={css(accountManagementTableNumericCellCss)}>
												Used
											</th>
										</tr>
									</thead>
									<tbody>
										{usage.entitlementConsumption.map((item) => (
											<tr key={item.resource}>
												<td mix={css(accountManagementTableCellCss)}>
													{item.label}
												</td>
												<td mix={css(accountManagementTableNumericCellCss)}>
													{formatUsageValue(item.resource, item.current)}
												</td>
												<td mix={css(accountManagementTableNumericCellCss)}>
													{formatUsageValue(item.resource, item.limit)}
												</td>
												<td
													mix={css({
														...accountManagementTableNumericCellCss,
														...(item.overEightyPercent
															? {
																	color: chartColor.amber,
																	fontWeight: typography.fontWeight.semibold,
																}
															: {}),
													})}
												>
													{formatUsagePercent(item.percentOfLimit)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</AccountManagementPanel>
					</>
				) : null}
			</AccountManagementShell>
		)
	}
}
