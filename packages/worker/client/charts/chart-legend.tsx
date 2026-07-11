import { css, type Handle } from 'remix/ui'
import { colors, spacing, typography } from '#client/styles/tokens.ts'

export type ChartLegendItem = {
	label: string
	color: string
	value?: string
}

type ChartLegendProps = {
	items: Array<ChartLegendItem>
}

/** Wrapped inline legend of colored dots for the larger charts. */
export function ChartLegend(handle: Handle<ChartLegendProps>) {
	return () => (
		<ul
			mix={css({
				listStyle: 'none',
				margin: 0,
				padding: 0,
				display: 'flex',
				flexWrap: 'wrap',
				gap: `${spacing.xs} ${spacing.lg}`,
			})}
		>
			{handle.props.items.map((item) => (
				<li
					key={item.label}
					mix={css({
						display: 'flex',
						alignItems: 'center',
						gap: spacing.sm,
						fontSize: typography.fontSize.sm,
						color: colors.textMuted,
					})}
				>
					<span
						aria-hidden="true"
						mix={css({
							width: '0.625rem',
							height: '0.625rem',
							borderRadius: '999px',
							backgroundColor: item.color,
							flexShrink: 0,
						})}
					/>
					{item.label}
					{item.value ? (
						<span
							mix={css({
								color: colors.text,
								fontWeight: typography.fontWeight.medium,
								fontVariantNumeric: 'tabular-nums',
							})}
						>
							{item.value}
						</span>
					) : null}
				</li>
			))}
		</ul>
	)
}
