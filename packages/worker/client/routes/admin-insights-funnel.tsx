import { css } from 'remix/ui'
import { colors, typography } from '#universal/styles/tokens.ts'
import {
	funnelEventLabels,
	type AdminFunnelSummary,
} from '#universal/funnel-events.ts'
import { formatIntegerNumber } from '#client/charts/chart-theme.ts'
import {
	ChartCard,
	ChartGrid,
	TableScroller,
	tableHeadCellCss,
	tableNumericCellCss,
	tableStickyColumnCss,
} from './admin-insights-sections.tsx'

const sourceLabel = {
	analytics_engine: 'Analytics Engine',
	d1: 'D1 mirror',
	unavailable: 'unavailable',
} as const

export function renderAdminFunnel(funnel: AdminFunnelSummary) {
	return (
		<ChartGrid>
			<ChartCard
				title="Onboarding funnel"
				sub={`Unique accounts in the last 7 and 28 days. Signup started counts page loads. Source: ${sourceLabel[funnel.source]}.`}
				span={12}
			>
				<TableScroller>
					<table
						aria-label="Onboarding funnel, last 7 and 28 days"
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
									mix={css({ ...tableHeadCellCss, textAlign: 'left' })}
								>
									Stage
								</th>
								<th
									scope="col"
									mix={css({ ...tableHeadCellCss, textAlign: 'right' })}
								>
									7 days
								</th>
								<th
									scope="col"
									mix={css({ ...tableHeadCellCss, textAlign: 'right' })}
								>
									28 days
								</th>
							</tr>
						</thead>
						<tbody>
							{funnel.stages.map((stage) => (
								<tr key={stage.event}>
									<th scope="row" mix={css(tableStickyColumnCss)}>
										{funnelEventLabels[stage.event]}
									</th>
									<td mix={css(tableNumericCellCss)}>
										{formatIntegerNumber(stage.days7)}
									</td>
									<td
										mix={css({
											...tableNumericCellCss,
											color: colors.textMuted,
										})}
									>
										{formatIntegerNumber(stage.days28)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</TableScroller>
			</ChartCard>
		</ChartGrid>
	)
}
