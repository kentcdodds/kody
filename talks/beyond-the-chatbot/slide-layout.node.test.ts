import { expect, test } from 'vitest'
import {
	assessSlideLayout,
	layoutThresholds,
	unionBoxes,
	type SlideLayoutMeasurement,
} from './slide-layout.ts'

test('unionBoxes returns the outer bounds of every box', () => {
	const union = unionBoxes([
		{ left: 10, top: 20, right: 40, bottom: 50 },
		{ left: 30, top: 5, right: 80, bottom: 25 },
	])

	expect(union).toEqual({ left: 10, top: 5, right: 80, bottom: 50 })
	expect(unionBoxes([])).toBeNull()
})

function measurement(
	overrides: Partial<SlideLayoutMeasurement> & {
		content?: SlideLayoutMeasurement['content']
		overflowPx?: number
	} = {},
): SlideLayoutMeasurement {
	return {
		index: 0,
		title: 'Test slide',
		slide: { left: 0, top: 0, right: 1920, bottom: 1080 },
		footerTop: 1080,
		content: { left: 200, top: 200, right: 1600, bottom: 800 },
		overflowPx: 0,
		...overrides,
	}
}

test('assessSlideLayout accepts content that fits and fills the frame', () => {
	const result = assessSlideLayout(measurement())

	expect(result.failures).toEqual([])
	expect(result.widthRatio).toBeGreaterThan(layoutThresholds.minWidthRatio)
	expect(result.heightRatio).toBeGreaterThan(layoutThresholds.minHeightRatio)
})

test('assessSlideLayout fails overflowing, empty, sparse, and top-stuck slides', () => {
	const overflowing = assessSlideLayout(measurement({ overflowPx: 24 }))
	expect(overflowing.failures.map((failure) => failure.code)).toContain(
		'overflow',
	)

	const empty = assessSlideLayout(measurement({ content: null }))
	expect(empty.failures.map((failure) => failure.code)).toContain('empty')

	const sparse = assessSlideLayout(
		measurement({
			content: { left: 40, top: 40, right: 280, bottom: 140 },
		}),
	)
	expect(sparse.failures.map((failure) => failure.code)).toEqual(
		expect.arrayContaining(['width', 'height', 'vertical-stuck']),
	)
})
