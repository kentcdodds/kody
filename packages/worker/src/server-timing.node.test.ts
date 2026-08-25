import { expect, test } from 'vitest'
import {
	applyServerTimingHeader,
	formatServerTimingHeader,
	parseServerTimingHeader,
	pushServerTiming,
	type ServerTimingEntry,
} from './server-timing.ts'

test('format and parse Server-Timing keep page phases and quoted desc', () => {
	const header = formatServerTimingHeader([
		{ name: 'session', durationMs: 12.4 },
		{ name: 'highlight', durationMs: 45.6, desc: 'hit' },
		{ name: 'code-runs', durationMs: 3 },
		{ name: 'not a token', durationMs: 1 },
		{ name: 'ssr', durationMs: -2 },
	])
	expect(header).toBe(
		'session;dur=12, highlight;dur=46;desc="hit", code-runs;dur=3, ssr;dur=0',
	)
	expect(parseServerTimingHeader(header)).toEqual([
		{ name: 'session', durationMs: 12 },
		{ name: 'highlight', durationMs: 46, desc: 'hit' },
		{ name: 'code-runs', durationMs: 3 },
		{ name: 'ssr', durationMs: 0 },
	])
	expect(
		parseServerTimingHeader('cfEdge;dur=9, highlight;dur=20;desc=worker'),
	).toEqual([
		{ name: 'cfEdge', durationMs: 9 },
		{ name: 'highlight', durationMs: 20, desc: 'worker' },
	])
	expect(parseServerTimingHeader(null)).toEqual([])
})

test('applyServerTimingHeader appends to an existing header', () => {
	const headers = new Headers({ 'Server-Timing': 'cfEdge;dur=4' })
	applyServerTimingHeader(headers, [
		{ name: 'session', durationMs: 8 },
		{ name: 'ssr', durationMs: 11 },
	])
	expect(headers.get('Server-Timing')).toBe(
		'cfEdge;dur=4, session;dur=8, ssr;dur=11',
	)
	applyServerTimingHeader(headers, [])
	expect(headers.get('Server-Timing')).toBe(
		'cfEdge;dur=4, session;dur=8, ssr;dur=11',
	)
})

test('pushServerTiming records I/O-bounded durations when a bag is present', async () => {
	const timings: Array<ServerTimingEntry> = []
	const value = await pushServerTiming(timings, 'listings', async () => {
		await new Promise((resolve) => setTimeout(resolve, 5))
		return 7
	})
	expect(value).toBe(7)
	expect(timings).toHaveLength(1)
	expect(timings[0]?.name).toBe('listings')
	expect(timings[0]?.durationMs).toBeGreaterThanOrEqual(5)

	expect(await pushServerTiming(undefined, 'skip', async () => 'ok')).toBe('ok')
})
