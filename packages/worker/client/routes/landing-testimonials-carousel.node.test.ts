import { expect, test } from 'vitest'
import {
	canPauseOnHover,
	listLanePlacements,
	wrapPagerIndex,
	wrapUnitInterval,
} from './landing-testimonials-motion.ts'

function largestVisibleHole(
	placements: Array<{ x: number }>,
	viewportWidth: number,
	cardWidth: number,
) {
	const spans = placements
		.map((placement) => ({
			start: Math.max(0, placement.x),
			end: Math.min(viewportWidth, placement.x + cardWidth),
		}))
		.filter((span) => span.end > span.start)
		.sort((left, right) => left.start - right.start)
	if (spans[0] == null) return viewportWidth
	let hole = spans[0].start
	let end = spans[0].end
	for (const span of spans.slice(1)) {
		if (span.start > end) hole = Math.max(hole, span.start - end)
		end = Math.max(end, span.end)
	}
	return Math.max(hole, viewportWidth - end)
}

test('lane placements wrap with a seam copy instead of leaving a hole', () => {
	expect(wrapUnitInterval(0, 1000)).toBe(0)
	expect(wrapUnitInterval(1000, 1000)).toBe(0)
	expect(wrapUnitInterval(1001, 1000)).toBe(1)
	expect(wrapUnitInterval(-1, 1000)).toBe(999)
	expect(wrapUnitInterval(50, 0)).toBe(0)

	expect(wrapPagerIndex(0, 4)).toBe(0)
	expect(wrapPagerIndex(-1, 4)).toBe(3)
	expect(wrapPagerIndex(4, 4)).toBe(0)

	const stride = 500
	const cardWidth = 480
	const count = 4
	const totalWidth = count * stride

	const atRest = listLanePlacements({
		count,
		stride,
		cardWidth,
		offset: 0,
		viewportWidth: 1200,
	})
	expect(atRest.map((placement) => placement.x)).toEqual(
		expect.arrayContaining([0, 500, 1000, 1500]),
	)
	expect(largestVisibleHole(atRest, 1200, cardWidth)).toBeLessThanOrEqual(
		stride - cardWidth,
	)

	const sliding = listLanePlacements({
		count,
		stride,
		cardWidth,
		offset: 10,
		viewportWidth: 1200,
	})
	expect(
		sliding.filter((placement) => placement.itemIndex === 0),
	).toContainEqual({ itemIndex: 0, x: -10, seam: false })
	expect(largestVisibleHole(sliding, 1200, cardWidth)).toBeLessThanOrEqual(
		stride - cardWidth,
	)

	const wide = listLanePlacements({
		count,
		stride,
		cardWidth,
		offset: 10,
		viewportWidth: 1920,
	})
	const wideZero = wide
		.filter((placement) => placement.itemIndex === 0)
		.sort((left, right) => left.x - right.x)
	expect(wideZero).toEqual([
		{ itemIndex: 0, x: -10, seam: false },
		{ itemIndex: 0, x: totalWidth - 10, seam: true },
	])
	expect(largestVisibleHole(wide, 1920, cardWidth)).toBeLessThanOrEqual(
		stride - cardWidth,
	)
	expect(wide.length).toBeLessThanOrEqual(count + 2)
})

test('narrow swipe moves the leading card off the origin instead of pinning it', () => {
	const stride = 320
	const cardWidth = 308
	const viewportWidth = 375

	const atRest = listLanePlacements({
		count: 4,
		stride,
		cardWidth,
		offset: 0,
		viewportWidth,
	})
	expect(atRest).toContainEqual({ itemIndex: 0, x: 0, seam: false })

	const swiped = listLanePlacements({
		count: 4,
		stride,
		cardWidth,
		offset: 80,
		viewportWidth,
	})
	const leading = swiped.filter((placement) => placement.itemIndex === 0)
	expect(leading).toContainEqual({ itemIndex: 0, x: -80, seam: false })
	expect(leading.some((placement) => placement.x === 0)).toBe(false)
	expect(largestVisibleHole(swiped, viewportWidth, cardWidth)).toBeLessThanOrEqual(
		stride - cardWidth,
	)

	expect(
		canPauseOnHover(() => ({ matches: false })),
	).toBe(false)
	expect(
		canPauseOnHover((query) => ({
			matches: query === '(hover: hover) and (pointer: fine)',
		})),
	).toBe(true)
})
