import { colors, mq, typography } from '#universal/styles/tokens.ts'

/**
 * Chart series palette. Mid-lightness hues chosen to stay legible on both
 * the light and dark surface colors.
 */
export const chartColor = {
	blue: '#3b82f6',
	emerald: '#10b981',
	amber: '#f59e0b',
	violet: '#8b5cf6',
	rose: '#f43f5e',
	cyan: '#06b6d4',
	lime: '#84cc16',
	fuchsia: '#d946ef',
	teal: '#14b8a6',
} as const

export const chartGridStroke =
	'color-mix(in srgb, var(--color-border) 55%, transparent)'

export const chartEmptyFill =
	'color-mix(in srgb, var(--color-border) 45%, transparent)'

export const chartAxisTextCss = {
	fill: colors.textMuted,
	fontSize: '11px',
	fontFamily: typography.fontFamily,
} as const

/**
 * Wraps a wide chart so it scrolls sideways on a phone. Pair with
 * `chartSvgCss` — without a floor on the SVG width the chart would just
 * shrink to the card and the 11px axis text with it.
 */
export const chartScrollerCss = {
	minWidth: 0,
	maxWidth: '100%',
	overflowX: 'auto' as const,
	WebkitOverflowScrolling: 'touch' as const,
} as const

/**
 * Same scroller, but starts scrolled to the right so a time series opens on
 * the newest points. The `rtl` container flips the initial scroll origin;
 * the SVG sets `ltr` back (see `chartSvgCss`) so nothing inside mirrors.
 */
export const chartScrollerNewestFirstCss = {
	...chartScrollerCss,
	direction: 'rtl' as const,
} as const

/**
 * Fluid SVG that fills its card, but on a phone never drops below ~85% of
 * its viewBox width so axis labels stay legible (the scroller above takes
 * the overflow).
 */
export function chartSvgCss(viewBoxWidth: number) {
	return {
		width: '100%',
		height: 'auto',
		display: 'block',
		direction: 'ltr',
		[mq.mobile]: { minWidth: `${Math.round(viewBoxWidth * 0.85)}px` },
	} as const
}

export function softColor(color: string, percent: number) {
	return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}

const compactFormatter = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1,
})

const integerFormatter = new Intl.NumberFormat('en-US')

export function formatCompactNumber(value: number) {
	return compactFormatter.format(value)
}

export function formatIntegerNumber(value: number) {
	return integerFormatter.format(value)
}

export function formatPercentShare(fraction: number) {
	if (!Number.isFinite(fraction)) return '0%'
	const percent = fraction * 100
	if (percent > 0 && percent < 1) return '<1%'
	return `${Math.round(percent)}%`
}
