import { expect, test } from 'vitest'
import {
	formatCodeRunsCount,
	interpolateCodeRunsCount,
	parsePublicCodeRunsWindow,
} from './code-runs.ts'

const windowStart = '2026-08-21T00:00:00.000Z'
const windowEnd = '2026-08-22T00:00:00.000Z'
const startMs = Date.parse(windowStart)
const hourMs = 60 * 60 * 1000

const window = {
	previous: 1000,
	current: 1240,
	windowStart,
	windowEnd,
}

test('interpolateCodeRunsCount stays monotonic, bursty, and inside the pair', () => {
	expect(interpolateCodeRunsCount(window, startMs - 1)).toBe(1000)
	expect(interpolateCodeRunsCount(window, startMs)).toBe(1000)
	expect(interpolateCodeRunsCount(window, startMs + 24 * hourMs)).toBe(1240)
	expect(interpolateCodeRunsCount(window, startMs + 30 * hourMs)).toBe(1240)
	expect(
		interpolateCodeRunsCount(window, startMs + 24 * hourMs - 1),
	).toBeLessThanOrEqual(1240)

	const hourly = Array.from({ length: 25 }, (_, hour) =>
		interpolateCodeRunsCount(window, startMs + hour * hourMs),
	)
	for (let index = 1; index < hourly.length; index += 1) {
		expect(hourly[index]!).toBeGreaterThanOrEqual(hourly[index - 1]!)
	}
	expect(hourly[0]).toBe(1000)
	expect(hourly[24]).toBe(1240)

	const hourlyDeltas = hourly
		.slice(1)
		.map((count, index) => count - hourly[index]!)
	const quietest = Math.min(...hourlyDeltas)
	const busiest = Math.max(...hourlyDeltas)
	expect(busiest).toBeGreaterThan(quietest)
	expect(interpolateCodeRunsCount(window, startMs + 12 * hourMs)).not.toBe(1120)
	const firstPair = { ...window, previous: 0, current: 1_000_000 }
	const secondPair = { ...firstPair, previous: 100, current: 1_000_100 }
	const sampleMs = startMs + 6 * hourMs
	expect(
		interpolateCodeRunsCount(firstPair, sampleMs) - firstPair.previous,
	).not.toBe(
		interpolateCodeRunsCount(secondPair, sampleMs) - secondPair.previous,
	)
})

test('interpolateCodeRunsCount advances at least every 3s with mixed step sizes', () => {
	const busy = { ...window, previous: 0, current: 86_400 }
	let previous = interpolateCodeRunsCount(busy, startMs)
	let lastAdvanceAt = 0
	let maxGap = 0
	let skippedSeconds = 0
	let multiStepSeconds = 0
	const stepSizes = new Set<number>()
	for (let second = 1; second < 86_400; second += 1) {
		const count = interpolateCodeRunsCount(busy, startMs + second * 1000)
		const step = count - previous
		expect(step).toBeGreaterThanOrEqual(0)
		expect(count).toBeLessThanOrEqual(86_400)
		if (step === 0) skippedSeconds += 1
		if (step > 1) multiStepSeconds += 1
		if (step > 0) {
			stepSizes.add(step)
			maxGap = Math.max(maxGap, second - lastAdvanceAt)
			lastAdvanceAt = second
		}
		previous = count
	}
	expect(previous).toBeLessThanOrEqual(86_400)
	expect(interpolateCodeRunsCount(busy, startMs + 86_400 * 1000)).toBe(86_400)
	expect(maxGap).toBeLessThanOrEqual(3)
	expect(skippedSeconds).toBeGreaterThan(0)
	expect(multiStepSeconds).toBeGreaterThan(0)
	expect(stepSizes.size).toBeGreaterThan(1)
})

test('interpolateCodeRunsCount is stable across milliseconds in the same second', () => {
	const wide = { ...window, previous: 0, current: 1_000_000_000 }
	const midSecond = startMs + 6 * hourMs + 100
	expect(interpolateCodeRunsCount(wide, midSecond)).toBe(
		interpolateCodeRunsCount(wide, midSecond + 800),
	)
})

test('interpolateCodeRunsCount stays one integer through a non-aligned window end', () => {
	const offset = {
		...window,
		previous: 171540,
		current: 257940,
		windowStart: '2026-08-22T15:47:07.637Z',
		windowEnd: '2026-08-23T15:47:07.637Z',
	}
	const endMs = Date.parse(offset.windowEnd)
	const endSecondMs = Math.floor(endMs / 1000) * 1000
	expect(interpolateCodeRunsCount(offset, endSecondMs + 100)).toBe(
		interpolateCodeRunsCount(offset, endSecondMs + 900),
	)
	expect(
		interpolateCodeRunsCount(offset, endSecondMs + 100),
	).toBeLessThanOrEqual(257940)
	expect(interpolateCodeRunsCount(offset, endSecondMs + 1000)).toBe(257940)
	expect(interpolateCodeRunsCount(offset, endMs + 1000)).toBe(257940)
})

test('interpolateCodeRunsCount sits still when the pair has not moved', () => {
	const still = { ...window, previous: 80, current: 80 }
	expect(interpolateCodeRunsCount(still, startMs + 6 * hourMs)).toBe(80)
})

test('parsePublicCodeRunsWindow accepts a valid pair and rejects junk', () => {
	expect(parsePublicCodeRunsWindow(window)).toEqual(window)
	expect(parsePublicCodeRunsWindow({ ...window, current: 900 })).toEqual({
		...window,
		current: 1000,
	})
	expect(parsePublicCodeRunsWindow({ ...window, previous: -1 })).toBeNull()
	expect(parsePublicCodeRunsWindow({ ...window, windowEnd: windowStart })).toBe(
		null,
	)
	expect(
		parsePublicCodeRunsWindow({
			...window,
			windowEnd: '2026-08-21T12:00:00.000Z',
		}),
	).toBeNull()
	expect(parsePublicCodeRunsWindow(null)).toBeNull()
})

test('formatCodeRunsCount uses grouping so reserved width stays stable', () => {
	expect(formatCodeRunsCount(128447)).toBe('128,447')
	expect(formatCodeRunsCount(0)).toBe('0')
})
