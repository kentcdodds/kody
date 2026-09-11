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
import {
	ChartCard,
	TableScroller,
	tableHeadCellCss,
	tableNumericCellCss,
	tableStickyColumnCss,
} from './admin-insights-sections.tsx'

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
		<TableScroller>
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
							mix={css({ ...tableHeadCellCss, ...tableStickyColumnCss })}
						>
							User
						</th>
						<th
							scope="col"
							mix={css({ ...tableHeadCellCss, textAlign: 'right' })}
						>
							Est. cost
						</th>
						<th
							scope="col"
							mix={css({ ...tableHeadCellCss, textAlign: 'right' })}
						>
							Paid
						</th>
						<th
							scope="col"
							mix={css({ ...tableHeadCellCss, textAlign: 'right' })}
						>
							Margin
						</th>
					</tr>
				</thead>
				<tbody>
					{input.rows.map((row) => (
						<tr key={row.stableUserId}>
							<td
								mix={css({
									...tableStickyColumnCss,
									padding: `${spacing.xs} ${spacing.sm}`,
									// Long usernames wrap inside a bounded column instead
									// of pushing every number off a phone screen.
									minWidth: '7rem',
									maxWidth: '12rem',
									overflowWrap: 'anywhere',
								})}
							>
								<a
									href={adminUserDetailHref(row.stableUserId)}
									mix={css({ color: colors.text, textDecoration: 'none' })}
								>
									{row.username}
								</a>
								{row.underwater ? (
									<span
										mix={css({
											display: 'inline-block',
											marginLeft: spacing.xs,
											color: colors.danger,
											fontSize: typography.fontSize.xs,
										})}
									>
										underwater
									</span>
								) : null}
							</td>
							<td mix={css(tableNumericCellCss)}>
								{formatDynamicWorkerUsd(row.estimatedGrossUsd)}
								<span mix={css({ color: colors.textMuted })}>
									{' '}
									({formatIntegerNumber(row.uniqueWorkerDays)})
								</span>
							</td>
							<td
								mix={css({ ...tableNumericCellCss, color: colors.textMuted })}
							>
								{formatUsdFromCents(row.estimatedPaidUsdCents)}
							</td>
							<td
								mix={css({
									...tableNumericCellCss,
									color: row.underwater ? colors.danger : colors.textMuted,
								})}
							>
								{formatMarginUsd(row.estimatedMarginUsd)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</TableScroller>
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
					alignItems: 'start',
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
