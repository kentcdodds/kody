import { expect, test } from 'vitest'
import {
	durationMsToDurableObjectGbSeconds,
	durableObjectDefaultMemoryGb,
	formatDurableObjectGbSeconds,
	toAdminDurableObjectDuration,
} from './durable-object-duration.ts'

test('durationMsToDurableObjectGbSeconds uses default 128 MB memory', () => {
	expect(durableObjectDefaultMemoryGb).toBe(0.128)
	expect(durationMsToDurableObjectGbSeconds(1000)).toBe(0.128)
	expect(durationMsToDurableObjectGbSeconds(10_000)).toBe(1.28)
	expect(durationMsToDurableObjectGbSeconds(0)).toBe(0)
	expect(durationMsToDurableObjectGbSeconds(-12)).toBe(0)
	expect(durationMsToDurableObjectGbSeconds(Number.NaN)).toBe(0)
})

test('toAdminDurableObjectDuration and formatDurableObjectGbSeconds stay observe-only', () => {
	expect(
		toAdminDurableObjectDuration({ durationMs: 10_000, rpcCount: 4.8 }),
	).toEqual({
		gbSeconds: 1.28,
		durationMs: 10_000,
		rpcCount: 4,
		memoryGb: 0.128,
	})
	expect(formatDurableObjectGbSeconds(0)).toBe('0 GB-s')
	expect(formatDurableObjectGbSeconds(0.00128)).toBe('0.0013 GB-s')
	expect(formatDurableObjectGbSeconds(0.128)).toBe('0.128 GB-s')
	expect(formatDurableObjectGbSeconds(1.28)).toBe('1.28 GB-s')
	expect(formatDurableObjectGbSeconds(12.4)).toBe('12 GB-s')
})
