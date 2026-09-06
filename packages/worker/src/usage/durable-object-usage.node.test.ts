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
	const metered = createMeteredDurableObjectStub({
		env: {},
		userId: 'user-1',
		doClass: 'UserMeter',
		stub,
	})

	await expect(metered.ping('ok')).resolves.toBe('pong:ok')
	expect(recordUsage).toHaveBeenCalledTimes(1)
	expect(recordUsage).toHaveBeenCalledWith(
		{},
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
		{},
		expect.objectContaining({
			eventType: 'durable_object_gb_seconds',
			entityId: 'UserMeter',
			outcome: 'error',
		}),
	)
})
