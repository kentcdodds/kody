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

/** Lane placements for four cards, asserting the no-hole invariant. */
function lane(
	stride: number,
	cardWidth: number,
	viewportWidth: number,
	offset: number,
) {
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
	return placements
}

const samples = (...points: Array<[t: number, x: number]>) =>
	points.map(([t, x]) => ({ t, x }))

function release(
	[startX, startY]: [number, number],
	lastX: number,
	[endX, endY, endT]: [number, number, number],
	gestureSamples: Array<{ t: number; x: number }>,
	dragging: boolean,
) {
	return finishPointerGesture({
		startX,
		startY,
		lastX,
		endX,
		endY,
		endT,
		samples: gestureSamples,
		dragging,
	})
}

test('lane placements wrap with a seam copy instead of leaving a hole', () => {
	const wraps: Array<[number, number, number]> = [
		[0, 1000, 0],
		[1000, 1000, 0],
		[1001, 1000, 1],
		[-1, 1000, 999],
		[50, 0, 0],
	]
	expect(
		wraps.filter(([v, n, want]) => wrapUnitInterval(v, n) !== want),
	).toEqual([])
	const pager: Array<[number, number, number]> = [
		[0, 4, 0],
		[-1, 4, 3],
		[4, 4, 0],
	]
	expect(pager.filter(([i, n, want]) => wrapPagerIndex(i, n) !== want)).toEqual(
		[],
	)

	const [stride, cardWidth, count] = [500, 480, 4]
	expect(lane(stride, cardWidth, 1200, 0).map((p) => p.x)).toEqual(
		expect.arrayContaining([0, 500, 1000, 1500]),
	)
	expect(
		lane(stride, cardWidth, 1200, 10).filter((p) => p.itemIndex === 0),
	).toContainEqual({ itemIndex: 0, x: -10, seam: false })

	const wide = lane(stride, cardWidth, 1920, 10)
	expect(
		wide
			.filter((p) => p.itemIndex === 0)
			.sort((left, right) => left.x - right.x),
	).toEqual([
		{ itemIndex: 0, x: -10, seam: false },
		{ itemIndex: 0, x: count * stride - 10, seam: true },
	])
	expect(wide.length).toBeLessThanOrEqual(count + 2)
})

test('narrow swipe moves the leading card off the origin instead of pinning it', () => {
	expect(lane(320, 308, 375, 0)).toContainEqual({
		itemIndex: 0,
		x: 0,
		seam: false,
	})
	const leading = lane(320, 308, 375, 80).filter((p) => p.itemIndex === 0)
	expect(leading).toContainEqual({ itemIndex: 0, x: -80, seam: false })
	expect(leading.some((p) => p.x === 0)).toBe(false)

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
	const paused: Array<[Partial<typeof idle>, boolean]> = [
		[{}, false],
		[{ focus: true }, true],
		[{ hover: true }, false],
		[{ matchesFocusWithin: true }, false],
		[{ hoverCapable: true, hover: true }, true],
	]
	expect(
		paused.filter(
			([state, want]) =>
				isTestimonialsLanePaused({ ...idle, ...state }) !== want,
		),
	).toEqual([])
})

test('an exiting card stays on the negative lane instead of snapping to the origin', () => {
	const [stride, cardWidth] = [500, 480]
	const offset = Math.round(cardWidth * 0.75)
	const placements = lane(stride, cardWidth, 1200, offset)
	const leading = placements.filter((p) => p.itemIndex === 0)
	expect(leading.some((p) => p.x === 0)).toBe(false)
	expect(leading).toContainEqual({ itemIndex: 0, x: -offset, seam: false })
	expect(placements.find((p) => p.itemIndex === 1)?.x).toBe(stride - offset)

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

	expect(cards[0]).toEqual({
		hidden: false,
		style: { transform: `translate3d(${-offset}px, 0, 0)` },
	})
	for (const card of [...cards, clone].filter((node) => !used.has(node))) {
		expect(card).toEqual({
			hidden: true,
			style: { transform: PARKED_TRANSFORM },
		})
	}
})

test('unused cards keep a parked transform instead of snapping to the origin', () => {
	const onStage = { hidden: true, style: { transform: PARKED_TRANSFORM } }
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

	const parked = { hidden: true, style: { transform: PARKED_TRANSFORM } }
	expect(onStage).toEqual({
		hidden: false,
		style: { transform: 'translate3d(140px, 0, 0)' },
	})
	expect(exiting).toEqual(parked)
	expect(clone).toEqual(parked)
})

test('a fast swipe coasts after release instead of freezing on the finger', () => {
	expect(classifyPointerIntent({ dx: 2, dy: 1 })).toBe('pending')
	expect(classifyPointerIntent({ dx: 24, dy: 4 })).toBe('drag')
	expect(classifyPointerIntent({ dx: 4, dy: 24 })).toBe('scroll')

	const flickSamples = samples([0, 300], [16, 240], [32, 170], [48, 90])
	const windowed = appendFlickSample(flickSamples, { t: 100, x: 80 })
	expect(windowed[0]?.t).toBe(32)
	expect(windowed).toHaveLength(3)
	expect(flickVelocityPxPerMs(flickSamples)).toBeGreaterThan(3)
	expect(shouldCoastFlick(0.2)).toBe(false)
	expect(shouldCoastFlick(flickVelocityPxPerMs(flickSamples))).toBe(true)

	const slowDrag = release(
		[200, 40],
		140,
		[140, 42, 400],
		samples([0, 200], [400, 140]),
		true,
	)
	expect(slowDrag).toMatchObject({
		dragging: true,
		offsetDelta: 0,
		coastVelocity: 0,
	})

	const coalescedFlick = release(
		[280, 20],
		280,
		[40, 28, 70],
		samples([0, 280]),
		false,
	)
	expect(coalescedFlick).toMatchObject({ dragging: true, offsetDelta: 240 })
	expect(coalescedFlick.coastVelocity).toBeGreaterThan(0)

	expect(
		release([280, 20], 280, [40, 28, 120], samples([0, 280]), false)
			.coastVelocity,
	).toBeGreaterThan(0)
	expect(samplesForFlickVelocity(samples([0, 280]), { t: 120, x: 40 })).toEqual(
		samples([0, 280], [120, 40]),
	)

	const pausedSamples = samples([0, 200], [10, 140])
	expect(
		release([200, 20], 140, [140, 20, 200], pausedSamples, true).coastVelocity,
	).toBe(0)
	expect(samplesForFlickVelocity(pausedSamples, { t: 200, x: 140 })).toEqual(
		samples([10, 140], [200, 140]),
	)

	expect(
		release([280, 20], 260, [40, 28, 120], samples([0, 280], [5, 260]), true)
			.coastVelocity,
	).toBeGreaterThan(0)

	expect(
		release([100, 20], 100, [108, 140, 40], samples([0, 100]), false),
	).toMatchObject({ dragging: false, coastVelocity: 0 })

	const cardWidth = 308
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
	expect(lane(320, cardWidth, 375, offset).some((p) => p.x === 0)).toBe(false)
})
