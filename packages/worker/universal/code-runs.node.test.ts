import { expect, test } from 'vitest'
import {
	codeRunsCatchUpDelayMs,
	codeRunsCatchUpSnapAfterMs,
	codeRunsHonestySlotMs,
	formatCodeRunsCount,
	interpolateCodeRunsCount,
	isStillPublicCodeRunsWindow,
	msUntilCodeRunsWindowRefresh,
	msUntilNextCodeRunsCount,
	nextDisplayedCodeRunsCount,
	parsePublicCodeRunsWindow,
	publicCodeRunsWindowsEqual,
} from './code-runs.ts'

const updateAt = '2026-08-22T00:00:00.000Z'
const startMs = Date.parse(updateAt) - 24 * 60 * 60 * 1000
const hourMs = 60 * 60 * 1000

const window = {
	start: 1000,
	end: 1240,
	updateAt,
}

test('interpolateCodeRunsCount stays monotonic, warped, and holds at bounds', () => {
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
	const firstPair = { ...window, start: 0, end: 1_000_000 }
	const secondPair = { ...firstPair, start: 100, end: 1_000_100 }
	const sampleMs = startMs + 6 * hourMs
	expect(
		interpolateCodeRunsCount(firstPair, sampleMs) - firstPair.start,
	).not.toBe(interpolateCodeRunsCount(secondPair, sampleMs) - secondPair.start)

	const offset = {
		...window,
		start: 171540,
		end: 257940,
		updateAt: '2026-08-23T15:47:07.637Z',
	}
	const endMs = Date.parse(offset.updateAt)
	expect(interpolateCodeRunsCount(offset, endMs - 1)).toBeLessThan(257940)
	expect(interpolateCodeRunsCount(offset, endMs)).toBe(257940)
	expect(interpolateCodeRunsCount(offset, endMs + 1000)).toBe(257940)
	expect(
		interpolateCodeRunsCount(
			{ ...window, start: 80, end: 80 },
			startMs + 6 * hourMs,
		),
	).toBe(80)

	expect(parsePublicCodeRunsWindow(window)).toEqual(window)
	expect(parsePublicCodeRunsWindow({ ...window, end: 900 })).toEqual({
		...window,
		end: 900,
	})
	expect(parsePublicCodeRunsWindow({ ...window, start: -1 })).toBeNull()
	expect(
		parsePublicCodeRunsWindow({ ...window, updateAt: 'not-a-date' }),
	).toBeNull()
	expect(
		parsePublicCodeRunsWindow({
			previous: 1000,
			current: 1240,
			windowStart: '2026-08-21T00:00:00.000Z',
			windowEnd: '2026-08-22T00:00:00.000Z',
		}),
	).toBeNull()
	expect(parsePublicCodeRunsWindow(null)).toBeNull()
})

test('interpolateCodeRunsCount wobbles +1 ticks without long idle when the pair is dense', () => {
	const busy = { ...window, start: 0, end: 86_400 }
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
	expect(maxGap).toBeLessThanOrEqual(codeRunsHonestySlotMs)
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

	const nowMs = startMs + 3 * hourMs + 250
	const here = interpolateCodeRunsCount(busy, nowMs)
	const wait = msUntilNextCodeRunsCount(busy, nowMs)
	expect(wait).not.toBeNull()
	expect(interpolateCodeRunsCount(busy, nowMs + wait! - 1)).toBe(here)
	expect(interpolateCodeRunsCount(busy, nowMs + wait!)).toBe(here + 1)
	expect(msUntilNextCodeRunsCount(busy, startMs + 24 * hourMs)).toBeNull()
	expect(
		msUntilNextCodeRunsCount({ ...window, start: 80, end: 80 }, nowMs),
	).toBeNull()
	expect(isStillPublicCodeRunsWindow({ ...window, start: 80, end: 80 })).toBe(
		true,
	)
	expect(isStillPublicCodeRunsWindow(window)).toBe(false)
})

test('interpolateCodeRunsCount rolls every extra integer inside a second', () => {
	const packed = { ...window, start: 0, end: 86_400 * 5 }
	const midSecond = startMs + 6 * hourMs
	const seen = new Set<number>()
	const offsets: Array<number> = []
	let previous = interpolateCodeRunsCount(packed, midSecond - 1)
	for (let offset = 0; offset < 1000; offset += 1) {
		const count = interpolateCodeRunsCount(packed, midSecond + offset)
		seen.add(count)
		expect(count).toBeGreaterThanOrEqual(previous)
		if (count > previous) {
			expect(count).toBe(previous + 1)
			offsets.push(offset)
			previous = count
		}
	}
	const values = [...seen].sort((left, right) => left - right)
	expect(offsets.length).toBeGreaterThanOrEqual(3)
	for (let index = 1; index < values.length; index += 1) {
		expect(values[index]).toBe(values[index - 1]! + 1)
	}
	const gaps = offsets.slice(1).map((offset, index) => offset - offsets[index]!)
	expect(new Set(gaps).size).toBeGreaterThan(1)
	const even = 1000 / offsets.length
	expect(gaps.some((gap) => Math.abs(gap - even) > 30)).toBe(true)

	const dense = { ...window, start: 0, end: 86_400 * 50 }
	const denseStart = startMs + 6 * hourMs
	let densePrevious = interpolateCodeRunsCount(dense, denseStart - 1)
	for (let offset = 0; offset < 30_000; offset += 1) {
		const count = interpolateCodeRunsCount(dense, denseStart + offset)
		expect(count - densePrevious).toBeGreaterThanOrEqual(0)
		expect(count - densePrevious).toBeLessThanOrEqual(1)
		densePrevious = count
	}
})

test('displayed code-runs catch-up snaps after a freeze and stays under the snap delay', () => {
	expect(formatCodeRunsCount(128447)).toMatch(/128.447/)
	expect(formatCodeRunsCount(0)).toBe('0')

	expect(
		nextDisplayedCodeRunsCount({
			displayed: 100,
			official: 100,
			elapsedMsSinceDisplay: 16,
		}),
	).toBe(100)
	expect(
		nextDisplayedCodeRunsCount({
			displayed: 100,
			official: 101,
			elapsedMsSinceDisplay: 16,
		}),
	).toBe(101)
	expect(
		nextDisplayedCodeRunsCount({
			displayed: 100,
			official: 108,
			elapsedMsSinceDisplay: 40,
		}),
	).toBe(101)
	expect(
		nextDisplayedCodeRunsCount({
			displayed: 100,
			official: 108,
			elapsedMsSinceDisplay: codeRunsCatchUpSnapAfterMs,
		}),
	).toBe(101)
	expect(
		nextDisplayedCodeRunsCount({
			displayed: 100,
			official: 108,
			elapsedMsSinceDisplay: codeRunsCatchUpSnapAfterMs + 1,
		}),
	).toBe(108)
	expect(
		nextDisplayedCodeRunsCount({
			displayed: 100,
			official: 102,
			elapsedMsSinceDisplay: 8_000,
		}),
	).toBe(102)
	expect(
		nextDisplayedCodeRunsCount({
			displayed: 100,
			official: 161,
			elapsedMsSinceDisplay: 16,
		}),
	).toBe(161)

	expect(codeRunsCatchUpDelayMs(1)).toBe(16)
	expect(codeRunsCatchUpDelayMs(102 - 100)).toBe(500)
	expect(codeRunsCatchUpDelayMs(102 - 101)).toBe(16)
	for (let behind = 1; behind <= 60; behind += 1) {
		expect(codeRunsCatchUpDelayMs(behind)).toBeLessThan(
			codeRunsCatchUpSnapAfterMs,
		)
	}
})

test('a 3-second backbone never waits longer than the honesty slot when budget allows', () => {
	const slots = (24 * 60 * 60 * 1000) / codeRunsHonestySlotMs
	const honest = { ...window, start: 0, end: slots }
	const gaps: Array<number> = []
	let at = startMs
	let previous = interpolateCodeRunsCount(honest, at)
	for (let step = 0; step < 200; step += 1) {
		const wait = msUntilNextCodeRunsCount(honest, at)
		expect(wait).not.toBeNull()
		expect(wait!).toBeGreaterThan(0)
		expect(wait!).toBeLessThanOrEqual(codeRunsHonestySlotMs)
		at += wait!
		const count = interpolateCodeRunsCount(honest, at)
		expect(count).toBe(previous + 1)
		gaps.push(wait!)
		previous = count
	}
	// The first wait is the hashed phase into the slot; after that the
	// backbone is a fixed 3-second cadence.
	expect(new Set(gaps.slice(1)).size).toBe(1)
	expect(gaps[1]).toBe(codeRunsHonestySlotMs)
})

test('thin windows sit on the integer until the next real +1', () => {
	const thin = { ...window, start: 10, end: 20 }
	const nowMs = startMs + 6 * hourMs
	const wait = msUntilNextCodeRunsCount(thin, nowMs)
	expect(wait).not.toBeNull()
	expect(wait!).toBeGreaterThan(codeRunsHonestySlotMs)
	const here = interpolateCodeRunsCount(thin, nowMs)
	expect(interpolateCodeRunsCount(thin, nowMs + codeRunsHonestySlotMs)).toBe(
		here,
	)
	expect(interpolateCodeRunsCount(thin, nowMs + wait!)).toBe(here + 1)
})

test('a regressing end shows immediately and refresh waits until updateAt', () => {
	const still = { start: 100, end: 100, updateAt }
	expect(publicCodeRunsWindowsEqual(still, still)).toBe(true)
	expect(publicCodeRunsWindowsEqual(still, { ...still, end: 101 })).toBe(false)
	expect(isStillPublicCodeRunsWindow({ start: 200, end: 150, updateAt })).toBe(
		true,
	)
	expect(
		interpolateCodeRunsCount(
			{ start: 200, end: 150, updateAt },
			startMs + 6 * hourMs,
		),
	).toBe(150)
	expect(
		msUntilNextCodeRunsCount(
			{ start: 200, end: 150, updateAt },
			startMs + 6 * hourMs,
		),
	).toBeNull()
	expect(msUntilCodeRunsWindowRefresh(window, startMs)).toBe(24 * hourMs)
	expect(msUntilCodeRunsWindowRefresh(window, Date.parse(updateAt))).toBe(0)
	expect(
		msUntilCodeRunsWindowRefresh(window, Date.parse(updateAt) + 1_000),
	).toBe(0)
})
