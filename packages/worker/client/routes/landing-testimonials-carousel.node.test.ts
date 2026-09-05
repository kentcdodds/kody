import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	PARKED_TRANSFORM,
	canPauseOnHover,
	listLanePlacements,
	parkUnusedLaneCards,
	placeLaneCard,
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
	expect(
		largestVisibleHole(swiped, viewportWidth, cardWidth),
	).toBeLessThanOrEqual(stride - cardWidth)

	expect(canPauseOnHover(() => ({ matches: false }))).toBe(false)
	expect(
		canPauseOnHover((query) => ({
			matches: query === '(hover: hover) and (pointer: fine)',
		})),
	).toBe(true)
})

test('an exiting card stays on the negative lane instead of snapping to the origin', () => {
	const stride = 500
	const cardWidth = 480
	const viewportWidth = 1200
	const offset = Math.round(cardWidth * 0.75)

	const placements = listLanePlacements({
		count: 4,
		stride,
		cardWidth,
		offset,
		viewportWidth,
	})
	const leading = placements.filter((placement) => placement.itemIndex === 0)
	expect(leading.some((placement) => placement.x === 0)).toBe(false)
	expect(leading).toContainEqual({ itemIndex: 0, x: -offset, seam: false })
	expect(placements.find((placement) => placement.itemIndex === 1)?.x).toBe(
		stride - offset,
	)
	expect(
		largestVisibleHole(placements, viewportWidth, cardWidth),
	).toBeLessThanOrEqual(stride - cardWidth)

	const cards = [0, 1, 2, 3].map(() => ({
		hidden: false,
		style: { transform: '' },
	}))
	const clone = { hidden: false, style: { transform: '' } }
	const used = new Set<(typeof cards)[number] | typeof clone>()
	for (const placement of placements) {
		const source = cards[placement.itemIndex]
		if (!source) continue
		const node = placement.seam ? clone : source
		placeLaneCard(node, placement.x)
		used.add(node)
	}
	parkUnusedLaneCards(cards, used)
	parkUnusedLaneCards([clone], used)

	expect(cards[0]?.hidden).toBe(false)
	expect(cards[0]?.style.transform).toBe(`translate3d(${-offset}px, 0, 0)`)
	expect(cards[0]?.style.transform).not.toBe('')
	expect(cards[0]?.style.transform).not.toBe(PARKED_TRANSFORM)
	for (const card of cards) {
		if (used.has(card)) continue
		expect(card.hidden).toBe(true)
		expect(card.style.transform).toBe(PARKED_TRANSFORM)
	}
	if (!used.has(clone)) {
		expect(clone.hidden).toBe(true)
		expect(clone.style.transform).toBe(PARKED_TRANSFORM)
	}
})

test('unused cards keep a parked transform instead of snapping to the origin', () => {
	const onStage = {
		hidden: true,
		style: { transform: PARKED_TRANSFORM },
	}
	const exiting = {
		hidden: false,
		style: { transform: 'translate3d(-360px, 0, 0)' },
	}
	const clone = {
		hidden: false,
		style: { transform: 'translate3d(1640px, 0, 0)' },
	}
	placeLaneCard(onStage, 140)
	parkUnusedLaneCards([onStage, exiting], new Set([onStage]))
	parkUnusedLaneCards([clone], new Set())

	expect(onStage.hidden).toBe(false)
	expect(onStage.style.transform).toBe('translate3d(140px, 0, 0)')
	expect(exiting.hidden).toBe(true)
	expect(exiting.style.transform).toBe(PARKED_TRANSFORM)
	expect(exiting.style.transform).not.toBe('')
	expect(clone.hidden).toBe(true)
	expect(clone.style.transform).toBe(PARKED_TRANSFORM)
})

test('virtual [hidden] cards override author display flex', () => {
	const css = readFileSync(
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../../public/styles.css',
		),
		'utf8',
	)
	expect(css).toMatch(
		/\.landing-testimonials-track\.is-virtual\s+\.landing-testimonial-card\[hidden\]\s*\{[^}]*display:\s*none/,
	)
})
