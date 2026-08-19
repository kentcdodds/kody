export type Box = {
	left: number
	top: number
	right: number
	bottom: number
}

export type SlideLayoutMeasurement = {
	index: number
	title: string
	slide: Box
	footerTop: number
	content: Box | null
	overflowPx: number
}

export type SlideLayoutFailureCode =
	| 'empty'
	| 'overflow'
	| 'width'
	| 'height'
	| 'vertical-stuck'

export type SlideLayoutFailure = {
	code: SlideLayoutFailureCode
	message: string
}

export type SlideLayoutAssessment = {
	failures: Array<SlideLayoutFailure>
	widthRatio: number
	heightRatio: number
	available: { width: number; height: number }
}

export const layoutThresholds = {
	maxOverflowPx: 2,
	minWidthRatio: 0.42,
	minHeightRatio: 0.24,
	maxUnbalancedGapRatio: 0.42,
	minOppositeGapRatio: 0.08,
} as const

export function unionBoxes(boxes: ReadonlyArray<Box>): Box | null {
	if (boxes.length === 0) {
		return null
	}

	return {
		left: Math.min(...boxes.map((box) => box.left)),
		top: Math.min(...boxes.map((box) => box.top)),
		right: Math.max(...boxes.map((box) => box.right)),
		bottom: Math.max(...boxes.map((box) => box.bottom)),
	}
}

export function boxWidth(box: Box) {
	return box.right - box.left
}

export function boxHeight(box: Box) {
	return box.bottom - box.top
}

export function availableSlideBox(measurement: SlideLayoutMeasurement): Box {
	return {
		left: measurement.slide.left,
		top: measurement.slide.top,
		right: measurement.slide.right,
		bottom: Math.min(measurement.slide.bottom, measurement.footerTop),
	}
}

export function assessSlideLayout(
	measurement: SlideLayoutMeasurement,
): SlideLayoutAssessment {
	const available = availableSlideBox(measurement)
	const availableWidth = boxWidth(available)
	const availableHeight = boxHeight(available)
	const failures: Array<SlideLayoutFailure> = []

	if (measurement.overflowPx > layoutThresholds.maxOverflowPx) {
		failures.push({
			code: 'overflow',
			message: `content overflows the slide by ${formatPx(measurement.overflowPx)} (max ${layoutThresholds.maxOverflowPx}px)`,
		})
	}

	if (!measurement.content || availableWidth <= 0 || availableHeight <= 0) {
		failures.push({
			code: 'empty',
			message: 'slide has no measurable content',
		})
		return {
			failures,
			widthRatio: 0,
			heightRatio: 0,
			available: { width: availableWidth, height: availableHeight },
		}
	}

	const widthRatio = boxWidth(measurement.content) / availableWidth
	const heightRatio = boxHeight(measurement.content) / availableHeight
	const topGap = measurement.content.top - available.top
	const bottomGap = available.bottom - measurement.content.bottom

	if (widthRatio < layoutThresholds.minWidthRatio) {
		failures.push({
			code: 'width',
			message: `content uses ${formatPct(widthRatio)} of slide width (min ${formatPct(layoutThresholds.minWidthRatio)})`,
		})
	}

	if (heightRatio < layoutThresholds.minHeightRatio) {
		failures.push({
			code: 'height',
			message: `content uses ${formatPct(heightRatio)} of slide height (min ${formatPct(layoutThresholds.minHeightRatio)})`,
		})
	}

	const stuckToTop =
		topGap < availableHeight * layoutThresholds.minOppositeGapRatio &&
		bottomGap > availableHeight * layoutThresholds.maxUnbalancedGapRatio
	const stuckToBottom =
		bottomGap < availableHeight * layoutThresholds.minOppositeGapRatio &&
		topGap > availableHeight * layoutThresholds.maxUnbalancedGapRatio

	if (stuckToTop || stuckToBottom) {
		failures.push({
			code: 'vertical-stuck',
			message: stuckToTop
				? 'content sits on the top edge and leaves the lower slide empty'
				: 'content sits on the bottom edge and leaves the upper slide empty',
		})
	}

	return {
		failures,
		widthRatio,
		heightRatio,
		available: { width: availableWidth, height: availableHeight },
	}
}

function formatPct(ratio: number) {
	return `${Math.round(ratio * 100)}%`
}

function formatPx(value: number) {
	return `${Math.round(value * 10) / 10}px`
}
