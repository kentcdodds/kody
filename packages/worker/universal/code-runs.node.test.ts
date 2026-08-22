import { expect, test } from 'vitest'
import {
	createPublicCodeRunsWindow,
	formatCodeRunsCount,
	interpolateCodeRunsCount,
	parsePublicCodeRunsWindow,
	publicCodeRunsWindowMs,
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

test('interpolateCodeRunsCount spreads yesterday’s delta across 24 hours and never overshoots', () => {
	expect(interpolateCodeRunsCount(window, startMs - 1)).toBe(1000)
	expect(interpolateCodeRunsCount(window, startMs)).toBe(1000)
	expect(interpolateCodeRunsCount(window, startMs + 12 * hourMs)).toBe(1120)
	expect(interpolateCodeRunsCount(window, startMs + 24 * hourMs - 1)).toBe(1239)
	expect(interpolateCodeRunsCount(window, startMs + 24 * hourMs)).toBe(1240)
	expect(interpolateCodeRunsCount(window, startMs + 30 * hourMs)).toBe(1240)
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

test('createPublicCodeRunsWindow builds an exact 24-hour pair from now', () => {
	const now = new Date('2026-08-22T15:00:00.000Z')
	expect(
		createPublicCodeRunsWindow({ previous: 171540, current: 257940, now }),
	).toEqual({
		previous: 171540,
		current: 257940,
		windowStart: '2026-08-22T15:00:00.000Z',
		windowEnd: new Date(now.getTime() + publicCodeRunsWindowMs).toISOString(),
	})
	expect(
		createPublicCodeRunsWindow({ previous: -1, current: 10, now }),
	).toBeNull()
})
