import { expect, test, vi } from 'vitest'

const recordUsage = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./record-usage.ts', () => ({
	recordUsage,
}))

import {
	createMeteredDurableObjectStub,
	flushDurableObjectUsageWrites,
} from './durable-object-usage.ts'

test('createMeteredDurableObjectStub coalesces same-outcome RPC wall-clock', async () => {
	const stub = {
		async ping(label: string) {
			return `pong:${label}`
		},
		async fail() {
			throw new Error('rpc failed')
		},
	}
	const env = {
		USAGE_EVENTS: { writeDataPoint() {} },
	}
	const metered = createMeteredDurableObjectStub({
		env,
		userId: 'user-1',
		doClass: 'StorageRunner',
		stub,
	})

	await expect(metered.ping('ok')).resolves.toBe('pong:ok')
	await expect(metered.ping('again')).resolves.toBe('pong:again')
	await expect(metered.fail()).rejects.toThrow('rpc failed')
	expect(recordUsage).not.toHaveBeenCalled()

	await flushDurableObjectUsageWrites()
	expect(recordUsage).toHaveBeenCalledTimes(2)
	expect(recordUsage).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			userId: 'user-1',
			eventType: 'durable_object_gb_seconds',
			entityId: 'StorageRunner',
			eventCount: 2,
			outcome: 'success',
		}),
	)
	expect(recordUsage).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			eventType: 'durable_object_gb_seconds',
			entityId: 'StorageRunner',
			eventCount: 1,
			outcome: 'error',
		}),
	)
	const successDuration = (
		recordUsage.mock.calls.find(
			(call) => (call[1] as { outcome: string }).outcome === 'success',
		)?.[1] as { durationMs: number }
	).durationMs
	expect(successDuration).toBeGreaterThanOrEqual(0)
})

test('createMeteredDurableObjectStub is a no-op without Analytics Engine', async () => {
	recordUsage.mockClear()
	const stub = {
		async ping() {
			return 'pong'
		},
	}
	const metered = createMeteredDurableObjectStub({
		env: {},
		userId: 'user-1',
		doClass: 'StorageRunner',
		stub,
	})
	await expect(metered.ping()).resolves.toBe('pong')
	expect(metered).toBe(stub)
	await flushDurableObjectUsageWrites()
	expect(recordUsage).not.toHaveBeenCalled()
})
