import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	PARKED_TRANSFORM,
	appendFlickSample,
	canPauseOnHover,
	classifyPointerIntent,
	finishPointerGesture,
	flickVelocityPxPerMs,
	isTestimonialsLanePaused,
	listLanePlacements,
	parkUnusedLaneCards,
	placeLaneCard,
	samplesForFlickVelocity,
	shouldCoastFlick,
	stepFlickCoast,
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

	const idle = {
		inView: true,
		userNudging: false,
		focus: false,
		hover: false,
		matchesHover: false,
		matchesFocusWithin: false,
		hoverCapable: false,
	}
	expect(isTestimonialsLanePaused(idle)).toBe(false)
	expect(isTestimonialsLanePaused({ ...idle, focus: true })).toBe(true)
	expect(isTestimonialsLanePaused({ ...idle, hover: true })).toBe(false)
	expect(isTestimonialsLanePaused({ ...idle, matchesFocusWithin: true })).toBe(
		false,
	)
	expect(
		isTestimonialsLanePaused({ ...idle, hoverCapable: true, hover: true }),
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

test('a fast swipe coasts after release instead of freezing on the finger', () => {
	expect(classifyPointerIntent({ dx: 2, dy: 1 })).toBe('pending')
	expect(classifyPointerIntent({ dx: 24, dy: 4 })).toBe('drag')
	expect(classifyPointerIntent({ dx: 4, dy: 24 })).toBe('scroll')

	const flickSamples = [
		{ t: 0, x: 300 },
		{ t: 16, x: 240 },
		{ t: 32, x: 170 },
		{ t: 48, x: 90 },
	]
	const windowed = appendFlickSample(flickSamples, { t: 100, x: 80 })
	expect(windowed[0]?.t).toBe(32)
	expect(windowed).toHaveLength(3)
	expect(flickVelocityPxPerMs(flickSamples)).toBeGreaterThan(3)
	expect(shouldCoastFlick(0.2)).toBe(false)
	expect(shouldCoastFlick(flickVelocityPxPerMs(flickSamples))).toBe(true)

	const slowDrag = finishPointerGesture({
		startX: 200,
		startY: 40,
		lastX: 140,
		endX: 140,
		endY: 42,
		endT: 400,
		samples: [
			{ t: 0, x: 200 },
			{ t: 400, x: 140 },
		],
		dragging: true,
	})
	expect(slowDrag.dragging).toBe(true)
	expect(slowDrag.offsetDelta).toBe(0)
	expect(slowDrag.coastVelocity).toBe(0)

	const coalescedFlick = finishPointerGesture({
		startX: 280,
		startY: 20,
		lastX: 280,
		endX: 40,
		endY: 28,
		endT: 70,
		samples: [{ t: 0, x: 280 }],
		dragging: false,
	})
	expect(coalescedFlick.dragging).toBe(true)
	expect(coalescedFlick.offsetDelta).toBe(240)
	expect(coalescedFlick.coastVelocity).toBeGreaterThan(0)

	const delayedCoalesced = finishPointerGesture({
		startX: 280,
		startY: 20,
		lastX: 280,
		endX: 40,
		endY: 28,
		endT: 120,
		samples: [{ t: 0, x: 280 }],
		dragging: false,
	})
	expect(delayedCoalesced.coastVelocity).toBeGreaterThan(0)
	expect(
		samplesForFlickVelocity([{ t: 0, x: 280 }], { t: 120, x: 40 }),
	).toEqual([
		{ t: 0, x: 280 },
		{ t: 120, x: 40 },
	])

	const vertical = finishPointerGesture({
		startX: 100,
		startY: 20,
		lastX: 100,
		endX: 108,
		endY: 140,
		endT: 40,
		samples: [{ t: 0, x: 100 }],
		dragging: false,
	})
	expect(vertical.dragging).toBe(false)
	expect(vertical.coastVelocity).toBe(0)

	const stride = 320
	const cardWidth = 308
	const viewportWidth = 375
	let offset = coalescedFlick.offsetDelta
	let velocity = coalescedFlick.coastVelocity
	const startOffset = offset
	let done = false
	for (let step = 0; step < 120 && !done; step += 1) {
		const next = stepFlickCoast({ offset, velocity, dt: 16 })
		offset = next.offset
		velocity = next.velocity
		done = next.done
	}
	expect(done).toBe(true)
	expect(velocity).toBe(0)
	expect(offset).toBeGreaterThan(startOffset + cardWidth)

	const placements = listLanePlacements({
		count: 4,
		stride,
		cardWidth,
		offset,
		viewportWidth,
	})
	expect(
		largestVisibleHole(placements, viewportWidth, cardWidth),
	).toBeLessThanOrEqual(stride - cardWidth)
	expect(placements.some((placement) => placement.x === 0)).toBe(false)
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
