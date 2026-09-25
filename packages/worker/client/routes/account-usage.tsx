import { type Handle, css } from 'remix/ui'
import { renderIcon } from '#universal/icon.tsx'
import { adminGrantDiffersFromSubscription } from '#universal/account-plan-display.ts'
import {
	type AccountUsageComputeOverage,
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
	type AdminPlanName,
} from '#universal/loader-data.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
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
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getAccentCalloutCss,
	hoverMq,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import { hasHigherPublicPlan } from '#universal/plans.ts'

const usageApiPath = '/account/usage.json'
const billingPath = '/account/billing'

const entitlementGroupOrder: Array<
	AccountUsageEntitlementConsumption['group']
> = ['monthly', 'daily', 'counts', 'storage', 'limits']

const entitlementGroupLabels: Record<
	AccountUsageEntitlementConsumption['group'],
	string
> = {
	monthly: 'Monthly compute',
	daily: 'Daily rates',
	counts: 'Resource counts',
	storage: 'Storage',
	limits: 'Per-item limits',
}

const entitlementGroupNotes: Partial<
	Record<AccountUsageEntitlementConsumption['group'], string>
> = {
	monthly:
		'Included unique worker days and Durable Object rows-read this UTC month.',
	daily:
		'Daily counters reset at UTC midnight. Execute and outbound fetches also have a this-week cap (UTC Monday–Sunday). High daily headroom for bursts; weekly total keeps it sustainable.',
}

function formatUsagePercent(value: number | null) {
	if (value === null) return '—'
	return `${Math.round(value * 100)}%`
}

/** Whichever window is closer to its cap — daily or weekly — is what blocks. */
export function hotterUsagePercent(
	item: Pick<AccountUsageEntitlementConsumption, 'percentOfLimit' | 'week'>,
) {
	const percents = [item.percentOfLimit, item.week?.percentOfLimit].filter(
		(value): value is number => value != null,
	)
	if (percents.length === 0) return null
	return Math.max(...percents)
}

/**
 * True when daily or weekly usage is at or over the hard cap. Used for the
 * warnings panel title so 100% reads as "Limit reached", not "Approaching".
 */
export function hasReachedEntitlementLimit(
	item: Pick<AccountUsageEntitlementConsumption, 'percentOfLimit' | 'week'>,
) {
	return (
		(item.percentOfLimit !== null && item.percentOfLimit >= 1) ||
		(item.week?.percentOfLimit != null && item.week.percentOfLimit >= 1)
	)
}

export function accountUsageWarningsPanelTitle(
	warnings: ReadonlyArray<
		Pick<AccountUsageEntitlementConsumption, 'percentOfLimit' | 'week'>
	>,
) {
	return warnings.some(hasReachedEntitlementLimit)
		? 'Limit reached'
		: 'Approaching limits'
}

export function formatEntitlementUsedPercent(
	item: Pick<AccountUsageEntitlementConsumption, 'percentOfLimit' | 'week'>,
) {
	if (item.week) {
		return `${formatUsagePercent(item.percentOfLimit)} today · ${formatUsagePercent(item.week.percentOfLimit)} this week`
	}
	return formatUsagePercent(item.percentOfLimit)
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

export function computeAccountUsageOverageNotice(
	overage: AccountUsageComputeOverage,
) {
	const overInclude = overage.meters.some((meter) => meter.percentOfLimit >= 1)
	const approaching = overage.meters.some(
		(meter) => meter.overEightyPercent && meter.percentOfLimit < 1,
	)
	if (overage.disposition === 'soft_block') {
		return {
			title: 'Upgrade to keep using compute overage',
			body: "You are over this month's unique worker-day or Durable Object rows-read include. Free accounts without a payment method are asked to upgrade instead of being charged.",
		}
	}
	if (overage.legacyUnbilled && (overInclude || approaching)) {
		return {
			title: 'Legacy plan compute includes',
			body: overInclude
				? "You are over this month's unique worker-day or Durable Object rows-read include. Legacy Standard and Pro are not billed for that overage. Changing plan moves you onto public rates."
				: "You are approaching this month's unique worker-day or Durable Object rows-read include. Legacy Standard and Pro are not billed if you go over.",
		}
	}
	if (!overage.chargingEnabled && (overInclude || approaching)) {
		return {
			title: 'Compute overage billing is paused',
			body: 'Your compute overage is being recorded, but it is not billed while charging is disabled.',
		}
	}
	if (overage.disposition === 'invoice' && overInclude) {
		return {
			title: 'Compute overage this month',
			body: 'Usage above your unique worker-day and Durable Object rows-read includes is billed at list rates after the UTC month closes.',
		}
	}
	if (approaching) {
		return {
			title: 'Approaching compute includes',
			body: "You are over 80% of this month's unique worker-day or Durable Object rows-read include. Public-ladder overage is billed at list rates when a payment method is on file.",
		}
	}
	return null
}

function formatCurrentValue(item: AccountUsageEntitlementConsumption) {
	if (item.kind === 'per_unit_max') return '—'
	return formatUsageValue(item.resource, item.current)
}

function formatLimitValue(item: AccountUsageEntitlementConsumption) {
	return formatUsageValue(item.resource, item.limit)
}

function usageProgressPercent(item: AccountUsageEntitlementConsumption) {
	const percent = hotterUsagePercent(item)
	if (percent === null) return null
	return Math.min(100, Math.round(percent * 100))
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

type UsageResourceNameProps = {
	id: string
	label: string
	whatCounts: string
	howToReduce: string
	/** Extra sentence that used to sit under the label, such as the weekly cap note. */
	note?: string
}

/**
 * Resource label plus the long "what counts / how to reduce" copy in a
 * popover. The table stays scannable; the explanation stays one click away
 * and is not clipped by the cell's overflow.
 */
export function UsageResourceName(handle: Handle<UsageResourceNameProps>) {
	return () => {
		const { id, label, whatCounts, howToReduce, note } = handle.props
		const panelId = `usage-resource-${id}`
		const anchor = `--usage-resource-${id}`
		return (
			<span
				mix={css({
					display: 'flex',
					alignItems: 'center',
					gap: '0.35rem',
					minWidth: 0,
					width: '100%',
				})}
			>
				<span
					mix={css({
						fontWeight: typography.fontWeight.medium,
						color: colors.text,
						// The cell is nowrap and the table columns are fixed, so a
						// long name would paint over the info button. Shrink the
						// label and keep the button in the row.
						flex: '0 1 auto',
						minWidth: 0,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					})}
				>
					{label}
				</span>
				<button
					type="button"
					popovertarget={panelId}
					aria-label={`What counts toward ${label}`}
					data-usage-resource-tip={id}
					mix={css({
						...usageTipButtonCss,
						anchorName: anchor,
					})}
				>
					{renderIcon('information', { size: '1.05rem' })}
				</button>
				<div
					id={panelId}
					popover
					role="dialog"
					aria-label={label}
					data-usage-resource-panel={id}
					mix={css({
						...usageTipPanelCss,
						positionAnchor: anchor,
					})}
				>
					<p mix={css(usageTipBodyCss)}>{whatCounts}</p>
					<p mix={css(usageTipBodyCss)}>{howToReduce}</p>
					{note ? <p mix={css(usageTipBodyCss)}>{note}</p> : null}
				</div>
			</span>
		)
	}
}

const usageTipButtonCss = {
	display: 'inline-flex',
	flex: 'none',
	alignItems: 'center',
	justifyContent: 'center',
	width: '1.75rem',
	height: '1.75rem',
	padding: 0,
	border: 'none',
	borderRadius: radius.full,
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			color: colors.text,
			backgroundColor: colors.primarySoft,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const usageTipPanelCss = {
	// Leave `display` unset so a closed popover keeps the UA `display: none`.
	positionArea: 'bottom span-right',
	positionTryFallbacks: 'flip-block, flip-inline',
	inset: 'auto',
	width: 'min(24rem, calc(100vw - 2.5rem))',
	maxHeight: 'min(70dvh, 20rem)',
	overflow: 'auto',
	gap: '0.55rem',
	margin: '0.35rem',
	padding: '0.85rem 1rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	background: colors.surface,
	color: colors.text,
	boxShadow: shadows.md,
	boxSizing: 'border-box' as const,
	'&:popover-open': {
		display: 'grid',
	},
}

const usageTipBodyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.45,
	textWrap: 'pretty' as const,
}

const weeklyUsageNote =
	'High daily headroom for bursts; the weekly total keeps it sustainable.'

function renderUsageProgressBar(item: AccountUsageEntitlementConsumption) {
	const percent = usageProgressPercent(item)
	if (percent === null) return null
	const barColor = item.overEightyPercent ? chartColor.amber : chartColor.blue
	return (
		<div
			role="img"
			aria-label={`${item.label}: ${formatEntitlementUsedPercent(item)} of plan limit`}
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
	const usageData = createRouteData({
		key: 'accountUsage',
		async load(_href, signal) {
			const response = await fetch(usageApiPath, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			const payload = await readJson<AccountUsageLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load usage.')
			}
			return payload
		},
	})

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const snapshot = usageData.read(handle, currentHref)
		const usage = snapshot.data
		const pending = snapshot.kind === 'pending'
		const message = snapshot.error?.message ?? null
		const groupedRows = usage
			? groupEntitlementRows(usage.entitlementConsumption)
			: []
		const computeNotice = usage
			? computeAccountUsageOverageNotice(usage.computeOverage)
			: null

		return (
			<AccountManagementShell busy={pending && usage !== null}>
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
				{pending && usage === null ? (
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
							<p mix={css(descriptionCss)}>
								Usage day (UTC): {usage.today}
								{usage.weekStart
									? ` · Week starts (UTC Monday): ${usage.weekStart}`
									: ''}
							</p>
							<p mix={css({ margin: 0 })}>
								<a href={billingPath} mix={css(primaryLinkCss)}>
									Manage billing
								</a>
							</p>
						</AccountManagementPanel>
						{computeNotice ? (
							<div
								mix={css(
									getAccentCalloutCss({
										accentColor:
											usage.computeOverage.disposition === 'soft_block'
												? chartColor.amber
												: colors.primary,
									}),
								)}
							>
								<p
									mix={css({
										margin: 0,
										fontWeight: typography.fontWeight.semibold,
										color: colors.text,
									})}
								>
									{computeNotice.title}
								</p>
								<p mix={css(descriptionCss)}>{computeNotice.body}</p>
								<p mix={css({ margin: 0 })}>
									<a href={billingPath} mix={css(primaryLinkCss)}>
										{usage.computeOverage.disposition === 'soft_block'
											? 'Upgrade your plan'
											: 'Review billing'}
									</a>
								</p>
							</div>
						) : null}
						<AccountManagementPanel
							title="Monthly compute"
							description="Unique worker-days and Durable Object rows-read against this month's include. Execute and outbound fetches are hard daily and weekly caps. Durable Object duration is unmetered."
						>
							<RecordTable
								mode="none"
								ariaLabel="Monthly compute usage"
								scrollHeight="none"
								columns={[
									{ key: 'resource', label: 'Resource', primary: true },
									{ key: 'current', label: 'In use', align: 'end' },
									{ key: 'include', label: 'Include', align: 'end' },
									{ key: 'used', label: 'Used', align: 'end' },
								]}
								rows={usage.computeOverage.meters.map((item) => ({
									id: item.resource,
									cells: {
										resource: (
											<UsageResourceName
												id={item.resource}
												label={item.label}
												whatCounts={item.whatCounts}
												howToReduce={item.howToReduce}
											/>
										),
										current: formatIntegerNumber(item.current),
										include: formatIntegerNumber(item.include),
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
									},
								}))}
							/>
						</AccountManagementPanel>
						{usage.warnings.length > 0 ? (
							<AccountManagementPanel
								title={accountUsageWarningsPanelTitle(usage.warnings)}
								description={
									usage.warnings.some(hasReachedEntitlementLimit)
										? 'These resources are at or over your plan limit.'
										: 'These resources are above 80% of your plan limit.'
								}
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
											<strong>{item.label}</strong>:{' '}
											{item.week
												? `${formatCurrentValue(item)} / ${formatLimitValue(item)} today (${formatUsagePercent(item.percentOfLimit)}) · ${formatIntegerNumber(item.week.current)} / ${formatIntegerNumber(item.week.limit)} this week (${formatUsagePercent(item.week.percentOfLimit)})`
												: `${formatCurrentValue(item)} / ${formatLimitValue(item)} (${formatUsagePercent(item.percentOfLimit)})`}
											. {item.howToReduce}
											{hasHigherPublicPlan(usage.plan) ? (
												<>
													{' '}
													<a href={billingPath} mix={css(primaryLinkCss)}>
														Upgrade your plan
													</a>
												</>
											) : null}
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
												<UsageResourceName
													id={item.resource}
													label={item.label}
													whatCounts={item.whatCounts}
													howToReduce={item.howToReduce}
													note={item.week ? weeklyUsageNote : undefined}
												/>
											),
											current: item.week
												? `${formatCurrentValue(item)} today · ${formatIntegerNumber(item.week.current)} this week`
												: formatCurrentValue(item),
											limit: item.week
												? `${formatLimitValue(item)} / day · ${formatIntegerNumber(item.week.limit)} / week`
												: formatLimitValue(item),
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
													{formatEntitlementUsedPercent(item)}
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
