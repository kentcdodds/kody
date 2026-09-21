import { expect, test } from 'vitest'
import {
	landingLeaderOrbAnchor,
	landingLeaderOrbExit,
	landingLeaderPath,
	landingLeaderWordAnchor,
} from './landing-lantern.ts'

test('leaders leave the orb rim and glide into the word dot on horizontal tangents', () => {
	const origin = { left: 10, top: 20 }
	expect(
		landingLeaderWordAnchor({ left: 410, top: 110, height: 10 }, origin),
	).toEqual({ x: 398, y: 95 })
	expect(
		landingLeaderOrbAnchor(
			{ left: 50, top: 220, width: 40, height: 40 },
			origin,
		),
	).toEqual({ x: 60, y: 220 })

	const exit = landingLeaderOrbExit({ x: 60, y: 220 }, { x: 160, y: 220 }, 50)
	expect(exit.x).toBeCloseTo(103, 5)
	expect(exit.y).toBe(220)
	expect(landingLeaderOrbExit({ x: 1, y: 1 }, { x: 1, y: 1 }, 50)).toEqual({
		x: 1,
		y: 1,
	})

	const from = { x: 60, y: 220 }
	const to = { x: 398, y: 95 }
	const path = landingLeaderPath(from, to)
	const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number)
	expect(path.startsWith('M60 220 C')).toBe(true)
	// Both control points share their endpoint's y: horizontal departure
	// from the orb, horizontal arrival at the dot.
	expect(numbers[3]).toBe(220)
	expect(numbers[2]).toBeGreaterThan(60)
	expect(numbers[5]).toBe(95)
	expect(numbers[4]).toBeLessThan(398)
	expect(numbers.slice(6)).toEqual([398, 95])
})
