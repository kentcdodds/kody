import { expect, test } from 'vitest'
import { waitForClientEntryReady } from './dev-client-ready.ts'

test('waitForClientEntryReady waits for a rewrite after sinceMs and stops on cancel or timeout', async () => {
	const files = new Map<string, { mtimeMs: number }>([
		['packages/worker/public/client-entry.js', { mtimeMs: 10 }],
	])
	let now = 0
	const slept: Array<number> = []

	const stale = await waitForClientEntryReady({
		sinceMs: 50,
		timeoutMs: 4,
		pollMs: 1,
		stat: (path) => files.get(path) ?? null,
		now: () => {
			now += 1
			return now
		},
		sleep: async (ms) => {
			slept.push(ms)
		},
	})
	expect(stale).toBe(false)
	expect(slept.length).toBeGreaterThan(0)

	now = 0
	const written = await waitForClientEntryReady({
		sinceMs: 50,
		timeoutMs: 10,
		pollMs: 1,
		stat: (path) => files.get(path) ?? null,
		now: () => {
			now += 1
			return now
		},
		sleep: async () => {
			files.set('packages/worker/public/client-entry.js', { mtimeMs: 80 })
		},
	})
	expect(written).toBe(true)

	now = 0
	const cancelled = await waitForClientEntryReady({
		sinceMs: 50,
		timeoutMs: 10,
		pollMs: 1,
		stat: () => ({ mtimeMs: 80 }),
		now: () => {
			now += 1
			return now
		},
		sleep: async () => {},
		isCancelled: () => true,
	})
	expect(cancelled).toBe(false)
})
