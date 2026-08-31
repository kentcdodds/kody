import { css, type Handle, type RemixNode } from 'remix/ui'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { cardCss } from '#universal/styles/style-primitives.ts'
import {
	chartColor,
	formatIntegerNumber,
	formatPercentShare,
} from '#client/charts/chart-theme.ts'
import {
	type AdminInsightsActivation,
	type AdminInsightsActivationStep,
	type AdminInsightsDurationConsumer,
	type AdminInsightsEntitlementPressureUser,
	type AdminInsightsEventCountConsumer,
	type AdminInsightsMetricDurationConsumers,
	type AdminInsightsPackageErrorRate,
	type AdminInsightsPackageErrorRateCounts,
	type AdminInsightsPackageErrorRateMetricRow,
} from '#universal/loader-data.ts'
import {
	adminUserDetailHref,
	formatDurationHours,
	formatPlanLabel,
	formatPressurePercent,
	runtimeDurationMetricLabels,
} from './admin-insights-shared.ts'

export function renderConsumerTable(input: {
	ariaLabel: string
	rows: Array<{
		key: string
		username: string
		stableUserId: string
		value: string
	}>
	emptyText: string
	valueHeader: string
}) {
	if (input.rows.length === 0) {
		return (
			<p mix={css({ margin: 0, color: colors.textMuted })}>{input.emptyText}</p>
		)
	}
	return (
		<table
			aria-label={input.ariaLabel}
			mix={css({
				width: '100%',
				borderCollapse: 'collapse',
				fontSize: typography.fontSize.sm,
			})}
		>
			<thead>
				<tr>
					<th
						scope="col"
						mix={css({
							textAlign: 'left',
							padding: `${spacing.xs} ${spacing.sm}`,
							color: colors.textMuted,
							fontWeight: typography.fontWeight.medium,
						})}
					>
						User
					</th>
					<th
						scope="col"
						mix={css({
							textAlign: 'right',
							padding: `${spacing.xs} ${spacing.sm}`,
							color: colors.textMuted,
							fontWeight: typography.fontWeight.medium,
						})}
					>
						{input.valueHeader}
					</th>
				</tr>
			</thead>
			<tbody>
				{input.rows.map((row) => (
					<tr key={row.key}>
						<td mix={css({ padding: `${spacing.xs} ${spacing.sm}` })}>
							<a
								href={adminUserDetailHref(row.stableUserId)}
								mix={css({ color: colors.text, textDecoration: 'none' })}
							>
								{row.username}
							</a>
						</td>
						<td
							mix={css({
								padding: `${spacing.xs} ${spacing.sm}`,
								textAlign: 'right',
								color: colors.textMuted,
								fontVariantNumeric: 'tabular-nums',
							})}
						>
							{row.value}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

export function renderDurationConsumers(
	consumers: Array<AdminInsightsDurationConsumer>,
	ariaLabel: string,
) {
	return renderConsumerTable({
		ariaLabel,
		emptyText: 'No runtime duration recorded this month yet.',
		valueHeader: 'Runtime',
		rows: consumers.map((consumer) => ({
			key: consumer.stableUserId,
			username: consumer.username,
			stableUserId: consumer.stableUserId,
			value: formatDurationHours(consumer.totalDurationMs),
		})),
	})
}

export function renderEventCountConsumers(
	consumers: Array<AdminInsightsEventCountConsumer>,
) {
	return renderConsumerTable({
		ariaLabel: 'Top event count consumers this month',
		emptyText: 'No metered events recorded this month yet.',
		valueHeader: 'Events',
		rows: consumers.map((consumer) => ({
			key: consumer.stableUserId,
			username: consumer.username,
			stableUserId: consumer.stableUserId,
			value: formatIntegerNumber(consumer.eventCount),
		})),
	})
}

export function renderDurationByMetric(
	entries: Array<AdminInsightsMetricDurationConsumers>,
) {
	const hasData = entries.some((entry) => entry.consumers.length > 0)
	if (!hasData) {
		return (
			<p mix={css({ margin: 0, color: colors.textMuted })}>
				No per-metric runtime leaders this month yet.
			</p>
		)
	}
	return (
		<div mix={css({ display: 'grid', gap: spacing.md })}>
			{entries.map((entry) => (
				<div key={entry.metric} mix={css({ display: 'grid', gap: spacing.xs })}>
					<h3
						mix={css({
							margin: 0,
							fontSize: typography.fontSize.sm,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						})}
					>
						{runtimeDurationMetricLabels[entry.metric]}
					</h3>
					{renderDurationConsumers(
						entry.consumers,
						`Top ${runtimeDurationMetricLabels[entry.metric]} duration consumers`,
					)}
				</div>
			))}
		</div>
	)
}

export function renderEntitlementPressure(
	entries: Array<AdminInsightsEntitlementPressureUser>,
) {
	if (entries.length === 0) {
		return (
			<p mix={css({ margin: 0, color: colors.textMuted })}>
				No accounts above 80% of a plan limit among the most active users this
				month.
			</p>
		)
	}
	return (
		<div mix={css({ display: 'grid', gap: spacing.md })}>
			{entries.map((entry) => (
				<div
					key={entry.stableUserId}
					mix={css({
						display: 'grid',
						gap: spacing.xs,
						padding: spacing.sm,
						borderRadius: '8px',
						border: `1px solid ${colors.border}`,
					})}
				>
					<div
						mix={css({
							display: 'flex',
							justifyContent: 'space-between',
							gap: spacing.sm,
							flexWrap: 'wrap',
						})}
					>
						<a
							href={adminUserDetailHref(entry.stableUserId)}
							mix={css({
								color: colors.text,
								fontWeight: typography.fontWeight.semibold,
								textDecoration: 'none',
							})}
						>
							{entry.username}
						</a>
						<span
							mix={css({
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
							})}
						>
							{formatPlanLabel(entry.plan)} plan
						</span>
					</div>
					<ul
						mix={css({
							margin: 0,
							paddingLeft: spacing.lg,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						})}
					>
						{entry.pressuredResources.map((resource) => (
							<li key={resource.resource}>
								{resource.label}: {formatIntegerNumber(resource.current)} /{' '}
								{formatIntegerNumber(resource.limit)} (
								{formatPressurePercent(resource.percentOfLimit)})
							</li>
						))}
					</ul>
				</div>
			))}
		</div>
	)
}

const packageErrorRateMetricLabels: Record<
	AdminInsightsPackageErrorRateMetricRow['metric'],
	string
> = {
	package_export: 'Package exports',
	package_static_call: 'Static package calls',
	job_run: 'Job runs',
	workflow_run: 'Workflow runs',
}

function formatErrorRate(counts: AdminInsightsPackageErrorRateCounts) {
	if (counts.rate == null) return 'n/a'
	return `${(counts.rate * 100).toFixed(1)}%`
}

export function renderPackageErrorRateSummary(input: {
	label: string
	counts: AdminInsightsPackageErrorRateCounts
}) {
	return (
		<div
			mix={css({
				display: 'grid',
				gap: spacing.xs,
				padding: spacing.sm,
				borderRadius: '8px',
				border: `1px solid ${colors.border}`,
			})}
		>
			<span
				mix={css({
					color: colors.textMuted,
					fontSize: typography.fontSize.sm,
				})}
			>
				{input.label}
			</span>
			<strong
				mix={css({
					fontSize: typography.fontSize.xl,
					fontVariantNumeric: 'tabular-nums',
				})}
			>
				{formatErrorRate(input.counts)}
			</strong>
			<span
				mix={css({
					color: colors.textMuted,
					fontSize: typography.fontSize.sm,
					fontVariantNumeric: 'tabular-nums',
				})}
			>
				{formatIntegerNumber(input.counts.errors)} /{' '}
				{formatIntegerNumber(input.counts.events)}
			</span>
		</div>
	)
}

export function renderPackageErrorRate(rate: AdminInsightsPackageErrorRate) {
	if (!rate.available || !rate.day) {
		return (
			<p mix={css({ margin: 0, color: colors.textMuted })}>
				Fleet package error rates are unavailable until the hourly usage
				aggregation writes the Analytics Engine snapshot.
			</p>
		)
	}
	const rows = rate.day.recent.by_metric.map((recent, index) => ({
		recent,
		previous: rate.day?.previous.by_metric[index] ?? recent,
	}))
	return (
		<div mix={css({ display: 'grid', gap: spacing.sm })}>
			<div
				mix={css({
					display: 'grid',
					gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
					gap: spacing.sm,
					[mq.tablet]: { gridTemplateColumns: 'minmax(0, 1fr)' },
				})}
			>
				{renderPackageErrorRateSummary({
					label: 'Last 24h',
					counts: rate.day.recent.combined,
				})}
				{renderPackageErrorRateSummary({
					label: 'Previous 24h',
					counts: rate.day.previous.combined,
				})}
				{rate.hour
					? renderPackageErrorRateSummary({
							label: 'Last hour',
							counts: rate.hour.recent.combined,
						})
					: null}
				{rate.hour
					? renderPackageErrorRateSummary({
							label: 'Previous hour',
							counts: rate.hour.previous.combined,
						})
					: null}
			</div>
			<table
				mix={css({
					width: '100%',
					borderCollapse: 'collapse',
					fontSize: typography.fontSize.sm,
				})}
			>
				<caption
					mix={css({
						captionSide: 'top',
						textAlign: 'left',
						color: colors.textMuted,
						paddingBottom: spacing.xs,
					})}
				>
					Anonymous combined rates for package_export, package_static_call,
					job_run, and workflow_run. No user ids or package names.
				</caption>
				<thead>
					<tr>
						<th mix={css({ textAlign: 'left', padding: spacing.xs })}>
							Metric
						</th>
						<th mix={css({ textAlign: 'right', padding: spacing.xs })}>
							Last 24h
						</th>
						<th mix={css({ textAlign: 'right', padding: spacing.xs })}>
							Previous 24h
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(({ recent, previous }) => (
						<tr key={recent.metric}>
							<td mix={css({ padding: spacing.xs })}>
								{packageErrorRateMetricLabels[recent.metric]}
							</td>
							<td
								mix={css({
									textAlign: 'right',
									padding: spacing.xs,
									fontVariantNumeric: 'tabular-nums',
								})}
							>
								{formatErrorRate(recent)}
							</td>
							<td
								mix={css({
									textAlign: 'right',
									padding: spacing.xs,
									fontVariantNumeric: 'tabular-nums',
									color: colors.textMuted,
								})}
							>
								{formatErrorRate(previous)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{rate.lastAlertAt ? (
				<p mix={css({ margin: 0, color: colors.textMuted })}>
					Last elevation alert {rate.lastAlertAt}.
				</p>
			) : null}
		</div>
	)
}

const activationStepLabels: Record<
	AdminInsightsActivationStep['step'],
	string
> = {
	signed_up: 'Signed up',
	email_verified: 'Verified email',
	agent_connected: 'Connected an agent',
	package_forked: 'Forked a package',
	package_run_succeeded: 'Package ran once',
	package_activated: 'Package ran twice',
}

export function activationSubtitle(activation: AdminInsightsActivation) {
	const activated =
		activation.steps.find((entry) => entry.step === 'package_activated')
			?.users ?? 0
	if (activated === 0) return 'Nobody has activated yet.'
	const median = activation.medianHoursToActivation
	// Activation can be recorded without usable timing — backfilled milestones
	// carry no verification date to measure from.
	if (median == null) {
		return `${formatIntegerNumber(activated)} activated; not enough timing data for a median.`
	}
	const rounded = median < 1 ? '<1' : formatIntegerNumber(Math.round(median))
	return `Median ${rounded}h from verified email to a package that ran twice.`
}

/**
 * Horizontal funnel. Bars are scaled against the first step so the drop-off
 * between stages is the thing you see; the per-row percentage is share of
 * signups, which is the number worth tracking over time.
 */
export function renderActivationFunnel(activation: AdminInsightsActivation) {
	const total = activation.steps[0]?.users ?? 0
	return (
		<div mix={css({ display: 'grid', gap: spacing.sm })}>
			{activation.steps.map((entry) => {
				const share = total > 0 ? entry.users / total : 0
				return (
					<div key={entry.step} mix={css({ display: 'grid', gap: spacing.xs })}>
						<div
							mix={css({
								display: 'flex',
								justifyContent: 'space-between',
								gap: spacing.sm,
								fontSize: typography.fontSize.sm,
								color: colors.text,
							})}
						>
							<span>{activationStepLabels[entry.step]}</span>
							<span mix={css({ color: colors.textMuted })}>
								{formatIntegerNumber(entry.users)} · {formatPercentShare(share)}
							</span>
						</div>
						<div
							role="img"
							aria-label={`${activationStepLabels[entry.step]}: ${entry.users} users, ${formatPercentShare(share)} of signups`}
							mix={css({
								height: '10px',
								borderRadius: '999px',
								background: colors.border,
								overflow: 'hidden',
							})}
						>
							<div
								mix={css({
									height: '100%',
									width: `${Math.round(share * 100)}%`,
									background:
										entry.step === 'package_activated'
											? chartColor.emerald
											: chartColor.blue,
								})}
							/>
						</div>
					</div>
				)
			})}
		</div>
	)
}

type ChartCardProps = {
	title: string
	sub?: string
	/** Grid column span on wide screens out of 12. */
	span?: 4 | 6 | 8 | 12
	legend?: RemixNode
	children: RemixNode
}

export function ChartCard(handle: Handle<ChartCardProps>) {
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
