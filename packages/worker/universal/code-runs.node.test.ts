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
	).toBeLessThan(1240)

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
	expect(busiest).toBeGreaterThan(quietest * 3)
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

test('interpolateCodeRunsCount is stable across milliseconds in the same second', () => {
	const wide = { ...window, previous: 0, current: 1_000_000_000 }
	const midSecond = startMs + 6 * hourMs + 100
	expect(interpolateCodeRunsCount(wide, midSecond)).toBe(
		interpolateCodeRunsCount(wide, midSecond + 800),
	)
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
