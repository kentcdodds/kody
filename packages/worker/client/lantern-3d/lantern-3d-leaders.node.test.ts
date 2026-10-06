import { expect, test } from 'vitest'
import {
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'
import {
	leaderEndHidden,
	leaderLanes,
	leaderListOrderHolds,
	leaderOrbEnd,
	leaderRunSpans,
	rankLeaderOrbs,
	routedLeaderPath,
	type LeaderOrb,
	type LeaderRank,
} from './lantern-3d-leaders.ts'

function ids(ranks: ReadonlyArray<LeaderRank>) {
	return ranks.map((rank) => rank.id)
}

function orb(
	id: LandingPrimitiveId,
	x: number,
	y: number,
	order = 0,
	radius = 28,
): LeaderOrb {
	return { id, x, y, radius, order }
}

/** The curve's start (on the bus) and its three control points. */
function curveOf(d: string, busX: number, y: number) {
	const match = /C(\S+) (\S+) (\S+) (\S+) (\S+) (\S+)$/.exec(d)
	if (!match) throw new Error(`no curve in ${d}`)
	const [c1x, c1y, c2x, c2y, x, endY] = match.slice(1).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	]
	return [
		{ x: busX, y },
		{ x: c1x, y: c1y },
		{ x: c2x, y: c2y },
		{ x, y: endY },
	] as const
}

function pointOn(
	curve: ReturnType<typeof curveOf>,
	t: number,
): { x: number; y: number } {
	const [a, b, c, d] = curve
	const u = 1 - t
	const weights = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
	return {
		x:
			a.x * weights[0]! +
			b.x * weights[1]! +
			c.x * weights[2]! +
			d.x * weights[3]!,
		y:
			a.y * weights[0]! +
			b.y * weights[1]! +
			c.y * weights[2]! +
			d.y * weights[3]!,
	}
}

test('words rank top to bottom by orb height', () => {
	const orbs = [
		orb('memory', 100, 260),
		orb('secrets', 140, 60),
		orb('packages', 90, 200),
		orb('triggers', 150, 120),
		orb('integrations', 80, 330),
		orb('apps', 120, 20),
	]
	expect(ids(rankLeaderOrbs([], orbs))).toEqual([
		'apps',
		'secrets',
		'triggers',
		'packages',
		'memory',
		'integrations',
	])
})

test('two orbs at nearly one height keep their words where they were', () => {
	const frameAt = (memoryY: number) =>
		landingPrimitiveIds.map((id, index) =>
			orb(id, 100, id === 'memory' ? memoryY : 40 + index * 40),
		)
	const firstTwo = (ranks: ReadonlyArray<LeaderRank>) => ids(ranks).slice(0, 2)
	// Secrets sits at 80. Memory drifting just under it does not trade...
	let ranks = rankLeaderOrbs([], frameAt(78))
	expect(firstTwo(ranks)).toEqual(['memory', 'secrets'])
	ranks = rankLeaderOrbs(ranks, frameAt(80.5))
	expect(firstTwo(ranks)).toEqual(['memory', 'secrets'])
	// ...until it is a little way under, and coming back level holds that.
	ranks = rankLeaderOrbs(ranks, frameAt(82))
	expect(firstTwo(ranks)).toEqual(['secrets', 'memory'])
	ranks = rankLeaderOrbs(ranks, frameAt(79.5))
	expect(firstTwo(ranks)).toEqual(['secrets', 'memory'])
	ranks = rankLeaderOrbs(ranks, frameAt(78))
	expect(firstTwo(ranks)).toEqual(['memory', 'secrets'])
})

test('taking over from the 2D layout, the words keep their order until the orbs agree with it', () => {
	// Heights when the 3D lantern took over: the 2D drift had packages a
	// little above secrets.
	const handoff = [
		orb('memory', 200, 421),
		orb('secrets', 120, 466),
		orb('packages', 280, 443),
		orb('triggers', 140, 504),
		orb('integrations', 260, 539),
		orb('apps', 200, 584),
	]
	expect(leaderListOrderHolds(handoff)).toBe(true)
	const lanes = leaderLanes(handoff)
	for (let rank = 1; rank < lanes.length; rank++) {
		expect(lanes[rank]! - lanes[rank - 1]!).toBeGreaterThan(7.9)
	}
	const moved = (id: LandingPrimitiveId, y: number) =>
		handoff.map((entry) => (entry.id === id ? { ...entry, y } : entry))
	// Once packages drifts below secrets, ranking by height already gives
	// the list order, so no word moves when it takes over.
	const agreed = moved('packages', 470)
	expect(leaderListOrderHolds(agreed)).toBe(false)
	expect(ids(rankLeaderOrbs([], agreed))).toEqual(landingPrimitiveIds)
	// An orb dragged far out of place before the handoff: holding the list
	// order would cross its line, so the words follow the heights at once.
	expect(leaderListOrderHolds(moved('apps', 380))).toBe(false)
})

test('a run breaks around the orbs it passes and nothing else', () => {
	const others = [orb('secrets', 200, 104), orb('apps', 320, 160)]
	// 4 px above the secrets centre: the gap is the chord at that height,
	// on the disc plus its 4 px of clearance.
	const spans = leaderRunSpans(100, 120, 400, others)
	const half = Math.sqrt(32 * 32 - 4 * 4)
	expect(spans).toHaveLength(2)
	expect(spans[0]![0]).toBe(120)
	expect(spans[0]![1]).toBeCloseTo(200 - half, 6)
	expect(spans[1]![0]).toBeCloseTo(200 + half, 6)
	expect(spans[1]![1]).toBe(400)
	// Clear of every disc (with the padding): one unbroken run.
	expect(leaderRunSpans(40, 120, 400, others)).toEqual([[120, 400]])
	// Starting inside another disc, the run begins past it.
	const inside = leaderRunSpans(160, 300, 400, others)
	expect(inside).toHaveLength(1)
	expect(inside[0]![0]).toBeCloseTo(352, 6)
})

test('a run hidden at the bus picks up again on the bus', () => {
	const d = routedLeaderPath({ x: 100, y: 50 }, 200, { x: 260, y: 90 }, [
		orb('apps', 190, 50),
	])
	expect(d.startsWith('M100 50H158')).toBe(true)
	expect(d).toContain('M200 50C')
	expect(d.endsWith(' 260 90')).toBe(true)
})

test('runs keep their own height unless two orbs sit level', () => {
	const spaced = [
		orb('memory', 100, 40),
		orb('secrets', 200, 80),
		orb('packages', 120, 120),
	]
	expect(leaderLanes(spaced)).toEqual([40, 80, 120])
	// Side by side at one height: the runs part evenly about it.
	const level = [
		orb('memory', 100, 40),
		orb('secrets', 80, 100),
		orb('apps', 200, 100),
		orb('packages', 120, 160),
	]
	expect(leaderLanes(level)).toEqual([40, 96, 104, 160])
	// Swapped inside the re-rank slack: the runs still keep the words' order.
	const lanes = leaderLanes([orb('memory', 100, 103), orb('apps', 200, 100)])
	expect(lanes[1]! - lanes[0]!).toBeCloseTo(8, 9)
	// A run never leaves past most of its orb's height.
	const crowded = landingPrimitiveIds.map((id) => orb(id, 100, 100))
	for (const lane of leaderLanes(crowded)) {
		expect(Math.abs(lane - 100)).toBeLessThanOrEqual(28 * 0.7 + 1e-9)
	}
	const end = leaderOrbEnd(orb('apps', 100, 100), 112)
	expect(end.y).toBe(112)
	expect(Math.hypot(end.x - 100, end.y - 100)).toBeCloseTo(28 * 0.9, 9)
})

test('leaders never cross while the words follow the orbs', () => {
	// Orbs scattered left and right through the glass in every height
	// order, some nearly level and some swapped inside the re-rank slack,
	// with the words in a fixed column.
	const rows = landingPrimitiveIds.map((_, index) => 60 + index * 40)
	const busX = 260
	const dotX = 330
	let seed = 7
	const random = () => {
		seed = (seed * 16807) % 2147483647
		return seed / 2147483647
	}
	const shuffled = <T>(items: ReadonlyArray<T>) =>
		items
			.map((item) => ({ item, key: random() }))
			.sort((a, b) => a.key - b.key)
			.map(({ item }) => item)
	for (let trial = 0; trial < 300; trial++) {
		const heights = shuffled(
			landingPrimitiveIds
				.map(() => random() * 160)
				.sort((a, b) => a - b)
				.map((height, index) => 40 + height + index * 3),
		)
		const orbs = landingPrimitiveIds.map((id, index) =>
			orb(id, 60 + random() * 160, heights[index]!, index, 26 + random() * 6),
		)
		// The frame before, a few pixels off, leaves keys to hold on to.
		const before = rankLeaderOrbs(
			shuffled(rankLeaderOrbs([], orbs)),
			orbs.map((entry) => ({ ...entry, y: entry.y + (random() - 0.5) * 10 })),
		)
		const ranked = rankLeaderOrbs(before, orbs).map(({ id }) =>
			orbs.find((entry) => entry.id === id)!,
		)
		for (const [rank, upper] of ranked.entries()) {
			for (const lower of ranked.slice(rank + 1)) {
				expect(upper.y).toBeLessThan(lower.y + 6)
			}
		}
		const lanes = leaderLanes(ranked)
		const curves = ranked.map((own, rank) => {
			const from = leaderOrbEnd(own, lanes[rank])
			const others = orbs.filter((other) => other.id !== own.id)
			const d = routedLeaderPath(
				from,
				busX,
				{ x: dotX, y: rows[rank]! },
				others,
			)
			return curveOf(d, busX, Math.round(from.y * 10) / 10)
		})
		for (let rank = 1; rank < lanes.length; rank++) {
			expect(lanes[rank]! - lanes[rank - 1]!).toBeGreaterThan(7.9)
		}
		for (let step = 0; step <= 50; step++) {
			const points = curves.map((curve) => pointOn(curve, step / 50))
			for (let rank = 1; rank < points.length; rank++) {
				expect(points[rank]!.x).toBeCloseTo(points[0]!.x, 6)
				expect(points[rank]!.y).toBeGreaterThan(points[rank - 1]!.y)
			}
		}
	}
})

test('an end dot hides only behind a nearer orb', () => {
	const far = orb('memory', 100, 100, 1)
	const end = leaderOrbEnd(far)
	const covering = (x: number, order: number) => [orb('apps', x, end.y, order)]
	expect(leaderEndHidden(far, end, covering(end.x + 10, 2))).toBe(true)
	expect(leaderEndHidden(far, end, covering(end.x + 10, 0))).toBe(false)
	expect(leaderEndHidden(far, end, covering(end.x + 40, 2))).toBe(false)
})
