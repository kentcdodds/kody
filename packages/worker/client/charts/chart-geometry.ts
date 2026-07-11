/**
 * Pure geometry helpers for the hand-rolled SVG charts. Kept free of DOM
 * and framework imports so they can be unit tested directly.
 */

export type ChartPoint = { x: number; y: number }

/** Smallest 1/2/2.5/5 x 10^n value that is >= the given value. */
export function niceMax(value: number) {
	if (!Number.isFinite(value) || value <= 0) return 1
	const exponent = Math.floor(Math.log10(value))
	const magnitude = 10 ** exponent
	const fraction = value / magnitude
	if (fraction <= 1) return magnitude
	if (fraction <= 2) return 2 * magnitude
	if (fraction <= 2.5) return 2.5 * magnitude
	if (fraction <= 5) return 5 * magnitude
	return 10 * magnitude
}

/** Evenly spaced axis tick values from 0 to niceMax(maxValue) inclusive. */
export function buildTicks(maxValue: number, count = 4) {
	const top = niceMax(maxValue)
	const ticks: Array<number> = []
	for (let index = 0; index <= count; index += 1) {
		ticks.push((top * index) / count)
	}
	return ticks
}

/**
 * Smooth open path through the given points using Catmull-Rom segments
 * converted to cubic beziers, clamped so the curve never dips below the
 * horizontal band of its neighboring points (avoids fake negative dips).
 */
export function buildSmoothLinePath(points: Array<ChartPoint>) {
	if (points.length === 0) return ''
	const start = points[0]
	if (!start) return ''
	if (points.length === 1) return `M ${round(start.x)} ${round(start.y)}`
	let path = `M ${round(start.x)} ${round(start.y)}`
	for (let index = 0; index < points.length - 1; index += 1) {
		const previous = points[index - 1] ?? points[index]
		const current = points[index]
		const next = points[index + 1]
		const following = points[index + 2] ?? next
		if (!previous || !current || !next || !following) continue
		const control1 = {
			x: current.x + (next.x - previous.x) / 6,
			y: clampBetween(current.y + (next.y - previous.y) / 6, current.y, next.y),
		}
		const control2 = {
			x: next.x - (following.x - current.x) / 6,
			y: clampBetween(
				next.y - (following.y - current.y) / 6,
				current.y,
				next.y,
			),
		}
		path += ` C ${round(control1.x)} ${round(control1.y)}, ${round(control2.x)} ${round(control2.y)}, ${round(next.x)} ${round(next.y)}`
	}
	return path
}

/** Closed path for the area under a smooth line down to the baseline. */
export function buildSmoothAreaPath(
	points: Array<ChartPoint>,
	baselineY: number,
) {
	const first = points[0]
	const last = points[points.length - 1]
	if (!first || !last) return ''
	const line = buildSmoothLinePath(points)
	return `${line} L ${round(last.x)} ${round(baselineY)} L ${round(first.x)} ${round(baselineY)} Z`
}

/**
 * SVG arc path along a circle, for donut slices drawn with strokes. Angles
 * are in radians with 0 at 12 o'clock, increasing clockwise.
 */
export function describeArc(
	cx: number,
	cy: number,
	radius: number,
	startAngle: number,
	endAngle: number,
) {
	const start = pointOnCircle(cx, cy, radius, startAngle)
	const end = pointOnCircle(cx, cy, radius, endAngle)
	const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
	return `M ${round(start.x)} ${round(start.y)} A ${radius} ${radius} 0 ${largeArc} 1 ${round(end.x)} ${round(end.y)}`
}

export type DonutSegmentGeometry = {
	startAngle: number
	endAngle: number
	fraction: number
}

/**
 * Angular segments for a donut chart with a small gap between slices.
 * Zero-value slices produce zero-length segments so indexes stay aligned
 * with the input values.
 */
export function buildDonutSegments(
	values: Array<number>,
	padAngle = 0.04,
): Array<DonutSegmentGeometry> {
	const total = values.reduce((sum, value) => sum + Math.max(0, value), 0)
	if (total <= 0) {
		return values.map(() => ({ startAngle: 0, endAngle: 0, fraction: 0 }))
	}
	const visibleCount = values.filter((value) => value > 0).length
	const gap = visibleCount > 1 ? padAngle : 0
	const available = Math.PI * 2 - gap * visibleCount
	let cursor = 0
	return values.map((value) => {
		const fraction = Math.max(0, value) / total
		if (value <= 0) {
			return { startAngle: cursor, endAngle: cursor, fraction: 0 }
		}
		const startAngle = cursor
		const endAngle = startAngle + available * fraction
		cursor = endAngle + gap
		return { startAngle, endAngle, fraction }
	})
}

export function pointOnCircle(
	cx: number,
	cy: number,
	radius: number,
	angle: number,
) {
	return {
		x: cx + radius * Math.sin(angle),
		y: cy - radius * Math.cos(angle),
	}
}

function clampBetween(value: number, boundA: number, boundB: number) {
	const min = Math.min(boundA, boundB)
	const max = Math.max(boundA, boundB)
	return Math.min(max, Math.max(min, value))
}

function round(value: number) {
	return Math.round(value * 100) / 100
}
