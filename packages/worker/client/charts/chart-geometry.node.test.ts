import { expect, test } from 'vitest'
import {
	buildDonutSegments,
	buildSmoothAreaPath,
	buildSmoothLinePath,
	buildTicks,
	niceMax,
} from './chart-geometry.ts'

test('chart axis helpers round up and space ticks evenly', () => {
	expect(niceMax(0)).toBe(1)
	expect(niceMax(1)).toBe(1)
	expect(niceMax(3)).toBe(5)
	expect(niceMax(7)).toBe(10)
	expect(niceMax(23)).toBe(25)
	expect(niceMax(120)).toBe(200)
	expect(niceMax(4900)).toBe(5000)
	expect(buildTicks(7)).toEqual([0, 2.5, 5, 7.5, 10])
	expect(buildTicks(0)).toEqual([0, 0.25, 0.5, 0.75, 1])
})

test('chart path and segment geometry handles common and edge cases', () => {
	const linePath = buildSmoothLinePath([
		{ x: 0, y: 10 },
		{ x: 10, y: 0 },
		{ x: 20, y: 10 },
	])
	expect(linePath.startsWith('M 0 10')).toBe(true)
	expect(linePath.match(/C /g)).toHaveLength(2)
	expect(buildSmoothLinePath([])).toBe('')
	expect(buildSmoothLinePath([{ x: 3, y: 4 }])).toBe('M 3 4')

	const areaPath = buildSmoothAreaPath(
		[
			{ x: 0, y: 10 },
			{ x: 10, y: 0 },
		],
		50,
	)
	expect(areaPath.endsWith('L 10 50 L 0 50 Z')).toBe(true)

	const segments = buildDonutSegments([3, 1], 0.04)
	expect(segments).toHaveLength(2)
	const first = segments[0]
	const second = segments[1]
	if (!first || !second) throw new Error('expected two segments')
	expect(first.fraction).toBeCloseTo(0.75)
	expect(second.fraction).toBeCloseTo(0.25)
	const firstSpan = first.endAngle - first.startAngle
	const secondSpan = second.endAngle - second.startAngle
	expect(firstSpan / secondSpan).toBeCloseTo(3)
	expect(firstSpan + secondSpan).toBeCloseTo(Math.PI * 2 - 0.08)

	expect(buildDonutSegments([0, 0])).toEqual([
		{ startAngle: 0, endAngle: 0, fraction: 0 },
		{ startAngle: 0, endAngle: 0, fraction: 0 },
	])
	const singleSlice = buildDonutSegments([5, 0], 0.04)
	const only = singleSlice[0]
	if (!only) throw new Error('expected a segment')
	expect(only.endAngle - only.startAngle).toBeCloseTo(Math.PI * 2)
	expect(singleSlice[1]?.fraction).toBe(0)
})
