import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { recordUniqueDynamicWorkerDay } from './dynamic-worker-day.ts'

test('recordUniqueDynamicWorkerDay records the first claim and skips repeats', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const meter = createInMemoryUserMeterEnv()
	const now = new Date('2026-09-01T12:00:00.000Z')

	await recordUniqueDynamicWorkerDay({
		env: meter.env,
		userId: 'user-1',
		workerId: 'kody-worker-a',
		now,
	})
	await recordUniqueDynamicWorkerDay({
		env: meter.env,
		userId: 'user-1',
		workerId: 'kody-worker-a',
		now,
	})
	await recordUniqueDynamicWorkerDay({
		env: meter.env,
		userId: 'user-1',
		workerId: 'kody-worker-b',
		now,
	})

	expect(recordUsageSpy).toHaveBeenCalledTimes(2)
	expect(recordUsageSpy.mock.calls[0]?.[1]).toEqual({
		userId: 'user-1',
		eventType: 'dynamic_worker_day',
		entityId: 'kody-worker-a',
		outcome: 'success',
		timestamp: now.toISOString(),
	})
	expect(recordUsageSpy.mock.calls[1]?.[1]).toEqual({
		userId: 'user-1',
		eventType: 'dynamic_worker_day',
		entityId: 'kody-worker-b',
		outcome: 'success',
		timestamp: now.toISOString(),
	})
	recordUsageSpy.mockRestore()
})

test('recordUniqueDynamicWorkerDay skips when USER_METER is missing', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const spy = vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)

	await recordUniqueDynamicWorkerDay({
		env: {},
		userId: 'user-1',
		workerId: 'kody-worker-a',
		now: new Date('2026-09-01T12:00:00.000Z'),
	})

	expect(spy).not.toHaveBeenCalled()
	spy.mockRestore()
})

test('recordUniqueDynamicWorkerDay skips anonymous runs and never throws', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const spy = vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const meter = createInMemoryUserMeterEnv()
	consoleWarn.mockImplementation(() => {})

	await recordUniqueDynamicWorkerDay({
		env: meter.env,
		userId: null,
		workerId: 'kody-worker-a',
	})
	await recordUniqueDynamicWorkerDay({
		env: {
			USER_METER: {
				idFromName() {
					throw new Error('meter exploded')
				},
				get() {
					throw new Error('meter exploded')
				},
			} as unknown as DurableObjectNamespace,
		},
		userId: 'user-1',
		workerId: 'kody-worker-a',
	})

	expect(spy).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'dynamic-worker-day-record-failed',
		expect.any(Error),
	)
	spy.mockRestore()
})
