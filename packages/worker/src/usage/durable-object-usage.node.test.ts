import { expect, test, vi } from 'vitest'

const recordUsage = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./record-usage.ts', () => ({
	recordUsage,
}))

import { createMeteredDurableObjectStub } from './durable-object-usage.ts'

test('createMeteredDurableObjectStub records RPC wall-clock as durable_object_gb_seconds', async () => {
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
		doClass: 'UserMeter',
		stub,
	})

	await expect(metered.ping('ok')).resolves.toBe('pong:ok')
	expect(recordUsage).toHaveBeenCalledTimes(1)
	expect(recordUsage).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			userId: 'user-1',
			eventType: 'durable_object_gb_seconds',
			entityId: 'UserMeter',
			outcome: 'success',
		}),
	)
	expect(
		(recordUsage.mock.calls[0]?.[1] as { durationMs: number }).durationMs,
	).toBeGreaterThanOrEqual(0)

	await expect(metered.fail()).rejects.toThrow('rpc failed')
	expect(recordUsage).toHaveBeenCalledTimes(2)
	expect(recordUsage).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({
			eventType: 'durable_object_gb_seconds',
			entityId: 'UserMeter',
			outcome: 'error',
		}),
	)
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
	expect(recordUsage).not.toHaveBeenCalled()
})
