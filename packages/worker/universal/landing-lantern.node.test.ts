import { expect, test } from 'vitest'
import { landingHomePrimitives } from './landing-home-copy.ts'
import {
	landingKodyLanternOrbs,
	landingLanternOrbs,
	landingLeaderOrbAnchor,
	landingLeaderPath,
	landingLeaderSide,
	landingLeaderWordAnchor,
	landingOrbitLightTone,
	landingPrimitiveColorVar,
	landingPrimitiveIds,
} from './landing-lantern.ts'

test('lantern orbs cover every homepage primitive exactly once, in copy order', () => {
	const copyIds = landingHomePrimitives.map((primitive) => primitive.id)
	expect(landingLanternOrbs.map((orb) => orb.id)).toEqual(copyIds)
	expect(landingKodyLanternOrbs.map((orb) => orb.id)).toEqual(copyIds)
	expect([...landingPrimitiveIds]).toEqual(copyIds)
	for (const orb of landingLanternOrbs) {
		expect(orb.x).toBeGreaterThan(0)
		expect(orb.x).toBeLessThan(100)
		expect(orb.y).toBeGreaterThan(0)
		expect(orb.y).toBeLessThan(100)
	}
	for (const orb of landingKodyLanternOrbs) {
		expect(Math.hypot(orb.dx, orb.dy)).toBeLessThan(0.8)
	}
	expect(landingPrimitiveColorVar('jobs')).toBe('var(--primitive-jobs)')
})

test('orbit light tones cycle through the five primitive colors', () => {
	expect(
		Array.from({ length: 8 }, (_, index) => landingOrbitLightTone(index)),
	).toEqual([
		'memory',
		'secrets',
		'packages',
		'jobs',
		'integrations',
		'memory',
		'secrets',
		'packages',
	])
	expect(landingOrbitLightTone(-1)).toBe('integrations')
})

test('leaders land on the word edge that faces the orb and arrive vertically', () => {
	const orb = { x: 100, y: 200 }
	const wordAbove = { top: 90, bottom: 110 }
	const wordBelow = { top: 300, bottom: 320 }
	expect(landingLeaderSide(orb, wordAbove)).toBe('bottom')
	expect(landingLeaderSide(orb, wordBelow)).toBe('top')

	const origin = { left: 10, top: 20 }
	const rect = { left: 410, width: 60, top: 110, bottom: 130 }
	expect(landingLeaderWordAnchor(rect, origin, 'bottom')).toEqual({
		x: 430,
		y: 114,
	})
	expect(landingLeaderWordAnchor(rect, origin, 'top')).toEqual({
		x: 430,
		y: 86,
	})
	expect(
		landingLeaderOrbAnchor(
			{ left: 50, top: 220, width: 40, height: 40 },
			origin,
		),
	).toEqual({ x: 60, y: 220 })

	const from = { x: 60, y: 220 }
	const to = { x: 430, y: 114 }
	const path = landingLeaderPath(from, to, 'bottom')
	const numbers = path.match(/-?\d+(\.\d+)?/g)!.map(Number)
	expect(path.startsWith('M60 220 C')).toBe(true)
	// First control point shares the orb's y (horizontal departure); second
	// shares the word's x and sits below it (vertical arrival from beneath).
	expect(numbers.slice(2, 4)).toEqual([60 + Math.abs(370) * 0.45, 220])
	expect(numbers[4]).toBe(430)
	expect(numbers[5]).toBeGreaterThan(114)
	expect(numbers.slice(6)).toEqual([430, 114])

	const fromTop = landingLeaderPath(from, { x: 430, y: 300 }, 'top')
	const topNumbers = fromTop.match(/-?\d+(\.\d+)?/g)!.map(Number)
	expect(topNumbers[5]).toBeLessThan(300)
	expect(topNumbers[5]).toBeGreaterThanOrEqual(300 - 56)
})
