import { css } from 'remix/ui'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	costVsPayFootnote,
	formatDynamicWorkerUsd,
} from '#universal/dynamic-worker-cost.ts'
import {
	type AdminInsightsDynamicWorkerCost,
	type AdminInsightsDynamicWorkerCostConsumer,
} from '#universal/loader-data.ts'
import {
	adminUserDetailHref,
	formatUsdFromCents,
} from './admin-insights-shared.ts'
import { ChartCard } from './admin-insights-sections.tsx'

function formatMarginUsd(amount: number) {
	const formatted = formatDynamicWorkerUsd(Math.abs(amount))
	if (amount > 0) return `+${formatted}`
	if (amount < 0) return `−${formatted}`
	return formatted
}

function renderCostVsPayTable(input: {
	ariaLabel: string
	emptyText: string
	rows: Array<AdminInsightsDynamicWorkerCostConsumer>
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
						Est. cost
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
						Paid
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
						Margin
					</th>
				</tr>
			</thead>
			<tbody>
				{input.rows.map((row) => (
					<tr key={row.stableUserId}>
						<td mix={css({ padding: `${spacing.xs} ${spacing.sm}` })}>
							<a
								href={adminUserDetailHref(row.stableUserId)}
								mix={css({ color: colors.text, textDecoration: 'none' })}
							>
								{row.username}
							</a>
							{row.underwater ? (
								<span
									mix={css({
										marginLeft: spacing.xs,
										color: colors.danger,
										fontSize: typography.fontSize.xs,
									})}
								>
									underwater
								</span>
							) : null}
						</td>
						<td
							mix={css({
								padding: `${spacing.xs} ${spacing.sm}`,
								textAlign: 'right',
								fontVariantNumeric: 'tabular-nums',
							})}
						>
							{formatDynamicWorkerUsd(row.estimatedGrossUsd)}
							<span mix={css({ color: colors.textMuted })}>
								{' '}
								({formatIntegerNumber(row.uniqueWorkerDays)})
							</span>
						</td>
						<td
							mix={css({
								padding: `${spacing.xs} ${spacing.sm}`,
								textAlign: 'right',
								color: colors.textMuted,
								fontVariantNumeric: 'tabular-nums',
							})}
						>
							{formatUsdFromCents(row.estimatedPaidUsdCents)}
						</td>
						<td
							mix={css({
								padding: `${spacing.xs} ${spacing.sm}`,
								textAlign: 'right',
								color: row.underwater ? colors.danger : colors.textMuted,
								fontVariantNumeric: 'tabular-nums',
							})}
						>
							{formatMarginUsd(row.estimatedMarginUsd)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

export function renderCostVsPay(cost: AdminInsightsDynamicWorkerCost) {
	return (
		<ChartCard
			title="Cost vs pay"
			sub={`${costVsPayFootnote} Top unique-worker-day users this month, then the underwater subset.`}
			span={12}
		>
			<div
				mix={css({
					display: 'grid',
					gap: spacing.lg,
					gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
					[mq.tablet]: {
						gridTemplateColumns: 'minmax(0, 1fr)',
					},
				})}
			>
				<div mix={css({ display: 'grid', gap: spacing.sm })}>
					<h3
						mix={css({
							margin: 0,
							fontSize: typography.fontSize.base,
						})}
					>
						Highest estimated cost
					</h3>
					{renderCostVsPayTable({
						ariaLabel: 'Highest estimated Dynamic Worker cost vs list pay',
						emptyText: 'No unique Dynamic Worker days recorded this month yet.',
						rows: cost.topConsumers,
					})}
				</div>
				<div mix={css({ display: 'grid', gap: spacing.sm })}>
					<h3
						mix={css({
							margin: 0,
							fontSize: typography.fontSize.base,
						})}
					>
						Underwater
					</h3>
					{renderCostVsPayTable({
						ariaLabel: 'Users whose estimated cost exceeds catalog list pay',
						emptyText: 'No scanned users are underwater this month.',
						rows: cost.underwaterConsumers,
					})}
				</div>
			</div>
		</ChartCard>
	)
}
