import { expect, test } from 'vitest'
import { landingHomePrimitives } from './landing-home-copy.ts'
import {
	landingLanternImage,
	landingLanternOrbs,
	landingLeaderOrbAnchor,
	landingLeaderOrbExit,
	landingLeaderPath,
	landingLeaderWordAnchor,
	landingOrbitLightTone,
	landingPrimitiveColorVar,
	landingPrimitiveIds,
} from './landing-lantern.ts'

test('lantern orbs cover every homepage primitive exactly once, in copy order', () => {
	const copyIds = landingHomePrimitives.map((primitive) => primitive.id)
	expect(landingLanternOrbs.map((orb) => orb.id)).toEqual(copyIds)
	expect([...landingPrimitiveIds]).toEqual(copyIds)
	const packagesOrb = landingLanternOrbs.find((orb) => orb.id === 'packages')!
	for (const orb of landingLanternOrbs) {
		expect(orb.x).toBeGreaterThan(0)
		expect(orb.x).toBeLessThan(100)
		expect(orb.y).toBeGreaterThan(0)
		expect(orb.y).toBeLessThan(100)
		expect(orb.size).toBe(packagesOrb.size)
		expect(orb.size).toBe(16.2)
		expect(orb.art).toBeGreaterThan(orb.size)
		expect(orb.art / orb.size).toBeGreaterThan(1.03)
		expect(orb.art / orb.size).toBeLessThan(1.08)
	}
	expect(landingLanternImage.srcSet).toContain(landingLanternImage.src)
	expect(landingLanternImage.src).toContain('lantern-shell')
	expect(landingLanternImage.width).toBe(863)
	expect(landingLanternImage.height).toBe(1242)
	expect(landingPrimitiveColorVar('triggers')).toBe('var(--primitive-triggers)')
	expect(landingPrimitiveColorVar('apps')).toBe('var(--primitive-apps)')
})

test('orbit light tones cycle through the six primitive colors', () => {
	expect(
		Array.from({ length: 9 }, (_, index) => landingOrbitLightTone(index)),
	).toEqual([
		'memory',
		'secrets',
		'packages',
		'triggers',
		'integrations',
		'apps',
		'memory',
		'secrets',
		'packages',
	])
	expect(landingOrbitLightTone(-1)).toBe('apps')
})

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
	expect(exit.x).toBeCloseTo(60 + 50 * 0.86, 5)
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
