import { expect, test } from 'vitest'
import {
	formatCodeRunsCount,
	interpolateCodeRunsCount,
	msUntilNextCodeRunsCount,
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

test('interpolateCodeRunsCount stays monotonic, warped, and inside the pair', () => {
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

test('interpolateCodeRunsCount wobbles +1 ticks without long idle when the pair is dense', () => {
	const busy = { ...window, previous: 0, current: 86_400 }
	const gaps: Array<number> = []
	let previous = interpolateCodeRunsCount(busy, startMs)
	let at = startMs
	for (let step = 0; step < 2_400; step += 1) {
		const wait = msUntilNextCodeRunsCount(busy, at)
		expect(wait).not.toBeNull()
		expect(wait!).toBeGreaterThan(0)
		at += wait!
		const count = interpolateCodeRunsCount(busy, at)
		expect(count).toBe(previous + 1)
		expect(count).toBeLessThan(86_400)
		gaps.push(wait!)
		previous = count
	}
	expect(interpolateCodeRunsCount(busy, startMs + 86_400 * 1000)).toBe(86_400)

	const minGap = Math.min(...gaps)
	const maxGap = Math.max(...gaps)
	expect(maxGap).toBeLessThanOrEqual(2_000)
	expect(minGap).toBeLessThan(800)
	expect(maxGap).toBeGreaterThan(1_100)
	expect(new Set(gaps).size).toBeGreaterThan(10)

	let densePrevious = interpolateCodeRunsCount(busy, startMs + 6 * hourMs)
	for (let offset = 10; offset <= 120_000; offset += 10) {
		const count = interpolateCodeRunsCount(busy, startMs + 6 * hourMs + offset)
		expect(count - densePrevious).toBeGreaterThanOrEqual(0)
		expect(count - densePrevious).toBeLessThanOrEqual(1)
		densePrevious = count
	}
})

test('interpolateCodeRunsCount rolls every extra integer inside a second', () => {
	const packed = { ...window, previous: 0, current: 86_400 * 5 }
	const midSecond = startMs + 6 * hourMs
	const seen = new Set<number>()
	const gaps: Array<number> = []
	let previous = interpolateCodeRunsCount(packed, midSecond)
	let lastAt = 0
	for (let offset = 0; offset < 1000; offset += 1) {
		const count = interpolateCodeRunsCount(packed, midSecond + offset)
		seen.add(count)
		if (count > previous) {
			expect(count).toBe(previous + 1)
			gaps.push(offset - lastAt)
			lastAt = offset
			previous = count
		}
	}
	const values = [...seen].sort((left, right) => left - right)
	expect(values.length).toBeGreaterThan(1)
	for (let index = 1; index < values.length; index += 1) {
		expect(values[index]).toBe(values[index - 1]! + 1)
	}
	expect(gaps.length).toBeGreaterThan(1)
	expect(new Set(gaps).size).toBeGreaterThan(1)
	const even = 1000 / (gaps.length + 1)
	expect(gaps.some((gap) => Math.abs(gap - even) > 30)).toBe(true)
})

test('msUntilNextCodeRunsCount lands on the next integer and then is still', () => {
	const busy = { ...window, previous: 0, current: 86_400 }
	const nowMs = startMs + 3 * hourMs + 250
	const here = interpolateCodeRunsCount(busy, nowMs)
	const wait = msUntilNextCodeRunsCount(busy, nowMs)
	expect(wait).not.toBeNull()
	expect(interpolateCodeRunsCount(busy, nowMs + wait! - 1)).toBe(here)
	expect(interpolateCodeRunsCount(busy, nowMs + wait!)).toBe(here + 1)
	expect(msUntilNextCodeRunsCount(busy, startMs + 24 * hourMs)).toBeNull()
	expect(
		msUntilNextCodeRunsCount({ ...window, previous: 80, current: 80 }, nowMs),
	).toBeNull()
})

test('interpolateCodeRunsCount holds current from the exact window end', () => {
	const offset = {
		...window,
		previous: 171540,
		current: 257940,
		windowStart: '2026-08-22T15:47:07.637Z',
		windowEnd: '2026-08-23T15:47:07.637Z',
	}
	const endMs = Date.parse(offset.windowEnd)
	expect(interpolateCodeRunsCount(offset, endMs - 1)).toBeLessThan(257940)
	expect(interpolateCodeRunsCount(offset, endMs)).toBe(257940)
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
