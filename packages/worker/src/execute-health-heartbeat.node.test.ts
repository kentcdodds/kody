import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	fleetExecuteHeartbeatCoalesceMs,
	fleetExecuteLastSuccessKvKey,
	readFleetExecuteLastSuccess,
	recordFleetExecuteLastSuccess,
	scheduleFleetExecuteLastSuccess,
	type FleetExecuteHeartbeatKv,
	type FleetExecuteHeartbeatMemory,
} from './execute-health-heartbeat.ts'

function memory(): FleetExecuteHeartbeatMemory {
	return { lastWriteAt: 0 }
}

function kv(
	initial?: string | null,
	hooks?: {
		onGet?: () => void
		onPut?: (key: string, value: string) => void
		getError?: Error
		putError?: Error
	},
): FleetExecuteHeartbeatKv & { store: Map<string, string> } {
	const store = new Map<string, string>()
	if (initial) store.set(fleetExecuteLastSuccessKvKey, initial)
	return {
		store,
		async get(key: string) {
			hooks?.onGet?.()
			if (hooks?.getError) throw hooks.getError
			return store.get(key) ?? null
		},
		async put(key: string, value: string) {
			hooks?.onPut?.(key, value)
			if (hooks?.putError) throw hooks.putError
			store.set(key, value)
		},
	} as FleetExecuteHeartbeatKv & { store: Map<string, string> }
}

test('heartbeat coalesces writes and stays fail-open so customer execute is not broken', async () => {
	const writes: Array<string> = []
	const store = kv(null, {
		onPut(_key, value) {
			writes.push(value)
		},
	})
	const shared = memory()
	const now = Date.parse('2026-09-07T17:00:00.000Z')

	for (const at of [now, now + 1_000, now + fleetExecuteHeartbeatCoalesceMs]) {
		await recordFleetExecuteLastSuccess({ kv: store, now: at, memory: shared })
	}
	expect(writes).toHaveLength(2)
	await expect(readFleetExecuteLastSuccess({ kv: store })).resolves.toEqual({
		at: now + fleetExecuteHeartbeatCoalesceMs,
	})

	consoleWarn.mockImplementation(() => {})
	const failing = kv(null, { putError: new Error('kv unavailable') })
	await expect(
		recordFleetExecuteLastSuccess({ kv: failing, now, memory: memory() }),
	).resolves.toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'fleet-execute-heartbeat-failed',
		'kv unavailable',
	)

	const scheduled: Array<Promise<unknown>> = []
	scheduleFleetExecuteLastSuccess({
		waitUntil: (promise) => {
			scheduled.push(promise)
			throw new Error('waitUntil exploded')
		},
		kv: store,
		now: now + 90_000,
		memory: memory(),
	})
	expect(scheduled).toHaveLength(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'fleet-execute-heartbeat-schedule-failed',
		'waitUntil exploded',
	)

	const fallbackStore = kv(null)
	const fallbackNow = now + 180_000
	await scheduleFleetExecuteLastSuccess({
		kv: fallbackStore,
		now: fallbackNow,
		memory: memory(),
	})
	await expect(
		readFleetExecuteLastSuccess({ kv: fallbackStore }),
	).resolves.toEqual({ at: fallbackNow })
})

test('public evidence reads stay cheap and treat missing or invalid telemetry as unknown', async () => {
	const reads = await Promise.all(
		[
			undefined,
			kv('{"nope":true}'),
			kv(null, { getError: new Error('read failed') }),
			kv(JSON.stringify({ at: 1_725_000_000_000 })),
			kv(JSON.stringify({ at: 8_640_000_000_000_001 })),
		].map((store) => readFleetExecuteLastSuccess({ kv: store })),
	)
	expect(reads).toEqual([null, null, null, { at: 1_725_000_000_000 }, null])
})

test('concurrent heartbeat calls in one isolate write once', async () => {
	let puts = 0
	const store = kv(null, {
		onPut() {
			puts += 1
		},
	})
	const shared = memory()
	const now = Date.parse('2026-09-07T17:00:00.000Z')
	await Promise.all([
		recordFleetExecuteLastSuccess({ kv: store, now, memory: shared }),
		recordFleetExecuteLastSuccess({ kv: store, now, memory: shared }),
	])
	expect(puts).toBe(1)
})
