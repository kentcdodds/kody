import { expect, test } from 'vitest'
import {
	heroOrbitArcPath,
	heroOrbitHub,
	heroOrbitPoint,
	heroOrbitSpokePath,
} from './landing-hero-orbit-geometry.ts'

test('hero orbit points sit on an upper arc above the Kody hub', () => {
	const total = 8
	const left = heroOrbitPoint(0, total)
	const mid = heroOrbitPoint(3, total)
	const right = heroOrbitPoint(total - 1, total)

	expect(left.x).toBeLessThan(heroOrbitHub.x)
	expect(right.x).toBeGreaterThan(heroOrbitHub.x)
	expect(mid.y).toBeLessThan(left.y)
	expect(mid.y).toBeLessThan(heroOrbitHub.y)
	expect(left.y).toBeLessThan(heroOrbitHub.y)
})

test('hero orbit spokes all originate near the hub', () => {
	const spoke = heroOrbitSpokePath(2, 8)
	expect(spoke.x1).toBe(heroOrbitHub.x)
	expect(spoke.y1).toBe(heroOrbitHub.y - 6)
	expect(spoke.y2).toBeLessThan(spoke.y1)
})

test('hero orbit arc path visits every host point', () => {
	const path = heroOrbitArcPath(4)
	expect(path.startsWith('M ')).toBe(true)
	expect(path.split(' L ').length).toBe(4)
})
