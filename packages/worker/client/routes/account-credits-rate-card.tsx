import { css } from 'remix/ui'
import { chartColor, formatIntegerNumber } from '#client/charts/chart-theme.ts'
import { accountDisclosureCss } from '#client/routes/account-management-components.tsx'
import { formatEstimatedCreditMicroUsd } from '#universal/credits.ts'
import { type AccountCreditsDebitMeter } from '#universal/loader-data.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

/** Collapsed rate card for Worker compute + Rows read on `/account/credits`. */
export function renderCreditsDebitRateCard(
	meters: Array<AccountCreditsDebitMeter>,
) {
	if (meters.length === 0) return null
	return (
		<details
			data-credits-rate-card
			mix={css({
				...accountDisclosureCss,
				borderTop: `1px solid ${colors.border}`,
				paddingTop: 'clamp(2rem, 4vw, 2.75rem)',
			})}
		>
			<summary>How credits are charged</summary>
			<div mix={css({ overflowX: 'auto' })}>
				<table
					aria-label="Credit debit rates and usage this period"
					mix={css(debitRateTableCss)}
				>
					<thead>
						<tr>
							<th scope="col">Meter</th>
							<th scope="col">Unit rate</th>
							<th scope="col" mix={css(debitRateNumericCss)}>
								Monthly include
							</th>
							<th scope="col" mix={css(debitRateNumericCss)}>
								Used this period
							</th>
							<th scope="col" mix={css(debitRateNumericCss)}>
								Past include
							</th>
							<th scope="col" mix={css(debitRateNumericCss)}>
								Est. credits this period
							</th>
						</tr>
					</thead>
					<tbody>
						{meters.map((meter) => {
							const barPercent = Math.min(
								100,
								Math.round(meter.percentOfInclude * 100),
							)
							const pastInclude = meter.pastInclude > 0
							return (
								<tr key={meter.meter} data-credits-debit-meter={meter.meter}>
									<th scope="row">
										<div mix={css(debitRateMeterCellCss)}>
											<span>{meter.label}</span>
											<div aria-hidden="true" mix={css(debitRateBarTrackCss)}>
												<div
													mix={css({
														...debitRateBarFillCss,
														width: `${barPercent}%`,
														background: pastInclude
															? chartColor.amber
															: chartColor.blue,
													})}
												/>
											</div>
										</div>
									</th>
									<td>{meter.unitRateLabel}</td>
									<td mix={css(debitRateNumericCss)}>
										{formatIntegerNumber(meter.include)}
									</td>
									<td mix={css(debitRateNumericCss)}>
										{formatIntegerNumber(meter.used)}
									</td>
									<td mix={css(debitRateNumericCss)}>
										{formatIntegerNumber(meter.pastInclude)}
									</td>
									<td mix={css(debitRateNumericCss)}>
										{formatEstimatedCreditMicroUsd(meter.estCreditsMicroUsd)}
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
		</details>
	)
}

const debitRateTableCss = {
	width: '100%',
	borderCollapse: 'collapse' as const,
	fontSize: typography.fontSize.sm,
	color: colors.text,
	'& th, & td': {
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
		textAlign: 'start' as const,
		verticalAlign: 'middle' as const,
	},
	'& thead th': {
		color: colors.textMuted,
		fontWeight: typography.fontWeight.semibold,
		whiteSpace: 'nowrap' as const,
	},
}

const debitRateNumericCss = {
	textAlign: 'end' as const,
	fontVariantNumeric: 'tabular-nums' as const,
	whiteSpace: 'nowrap' as const,
}

const debitRateMeterCellCss = {
	display: 'grid',
	gap: '0.35rem',
	minWidth: '8rem',
	fontWeight: typography.fontWeight.semibold,
	color: colors.text,
}

const debitRateBarTrackCss = {
	height: '8px',
	borderRadius: radius.md,
	background: colors.border,
	overflow: 'hidden',
	minWidth: '4rem',
	maxWidth: '10rem',
}

const debitRateBarFillCss = {
	height: '100%',
}
