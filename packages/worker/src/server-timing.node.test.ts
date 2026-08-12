import { expect, test } from 'vitest'
import { pushServerTiming, type ServerTimingEntry } from './server-timing.ts'

test('pushServerTiming records duration when a collector is provided and skips when omitted', async () => {
	const timings: Array<ServerTimingEntry> = []
	const value = await pushServerTiming(timings, 'phase-a', async () => {
		await Promise.resolve()
		return 7
	})
	expect(value).toBe(7)
	expect(timings).toEqual([{ name: 'phase-a', durationMs: expect.any(Number) }])
	expect(timings[0]?.durationMs).toBeGreaterThanOrEqual(0)

	const skipped = await pushServerTiming(undefined, 'phase-b', async () => 'ok')
	expect(skipped).toBe('ok')
	expect(timings).toHaveLength(1)
})
