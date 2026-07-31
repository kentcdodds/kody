import { expect, test, vi, type MockInstance } from 'vitest'
import { createPackageStaticCallMeterTools } from './package-static-call-usage.ts'

async function withRecordUsageSpy(
	run: (recordUsageSpy: MockInstance) => Promise<void>,
) {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	try {
		await run(recordUsageSpy)
	} finally {
		recordUsageSpy.mockRestore()
	}
}

test('records only granted, valid, sanitized package_static_call events', async () => {
	await withRecordUsageSpy(async (recordUsageSpy) => {
		const env = {} as Env
		const tools = createPackageStaticCallMeterTools({
			env,
			userId: 'user-1',
			grantedPackageIds: new Set(['pkg-callee']),
		})
		expect(tools).toBeDefined()

		await tools?.record({
			events: [
				{ packageId: 'pkg-callee', durationMs: 42, outcome: 'success' },
				{ packageId: 'pkg-callee', durationMs: 7, outcome: 'error' },
				{
					packageId: 'pkg-other-users-package',
					durationMs: 1,
					outcome: 'success',
				},
				{ packageId: '', durationMs: 1, outcome: 'success' },
				{ durationMs: 1, outcome: 'success' },
				{ packageId: 42, durationMs: 1, outcome: 'success' },
				'not-an-object',
				{ packageId: 'pkg-callee', durationMs: 1, outcome: 'made-up' },
			],
		})
		expect(recordUsageSpy).toHaveBeenCalledTimes(2)
		expect(recordUsageSpy).toHaveBeenNthCalledWith(1, env, {
			userId: 'user-1',
			eventType: 'package_static_call',
			entityId: 'pkg-callee',
			durationMs: 42,
			outcome: 'success',
		})
		expect(recordUsageSpy).toHaveBeenNthCalledWith(
			2,
			env,
			expect.objectContaining({
				entityId: 'pkg-callee',
				outcome: 'error',
				durationMs: 7,
			}),
		)

		recordUsageSpy.mockClear()
		await tools?.record({
			events: [
				{ packageId: 'pkg-callee', durationMs: -5, outcome: 'success' },
				{
					packageId: 'pkg-callee',
					durationMs: 'not-a-number',
					outcome: 'success',
				},
			],
		})
		expect(recordUsageSpy).toHaveBeenCalledTimes(2)
		for (const call of recordUsageSpy.mock.calls) {
			expect(call[1]).toEqual(expect.objectContaining({ durationMs: null }))
		}
	})
})

test('caps recorded events per run, cumulatively across batches', async () => {
	await withRecordUsageSpy(async (recordUsageSpy) => {
		const tools = createPackageStaticCallMeterTools({
			env: {} as Env,
			userId: 'user-1',
			grantedPackageIds: new Set(['pkg-callee']),
		})
		const grantedEvent = {
			packageId: 'pkg-callee',
			durationMs: 1,
			outcome: 'success',
		}
		await tools?.record({
			events: Array.from({ length: 500 }, () => grantedEvent),
		})
		expect(recordUsageSpy).toHaveBeenCalledTimes(200)

		recordUsageSpy.mockClear()
		await tools?.record({
			events: Array.from({ length: 50 }, () => grantedEvent),
		})
		expect(recordUsageSpy).not.toHaveBeenCalled()

		const freshTools = createPackageStaticCallMeterTools({
			env: {} as Env,
			userId: 'user-1',
			grantedPackageIds: new Set(['pkg-callee']),
		})
		await freshTools?.record({
			events: Array.from({ length: 150 }, () => grantedEvent),
		})
		await freshTools?.record({
			events: Array.from({ length: 150 }, () => grantedEvent),
		})
		expect(recordUsageSpy).toHaveBeenCalledTimes(200)
	})
})

test('requires a calling user and never throws into the call path', async () => {
	expect(
		createPackageStaticCallMeterTools({
			env: {} as Env,
			userId: null,
			grantedPackageIds: new Set(['pkg-callee']),
		}),
	).toBeUndefined()
	expect(
		createPackageStaticCallMeterTools({
			env: {} as Env,
			userId: '   ',
			grantedPackageIds: new Set(['pkg-callee']),
		}),
	).toBeUndefined()

	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockImplementation(() => {
			throw new Error('sink exploded')
		})
	try {
		const tools = createPackageStaticCallMeterTools({
			env: {} as Env,
			userId: 'user-1',
			grantedPackageIds: new Set(['pkg-callee']),
		})
		await expect(
			tools?.record({
				events: [
					{ packageId: 'pkg-callee', durationMs: 1, outcome: 'success' },
				],
			}),
		).resolves.toBeUndefined()
		await expect(
			tools?.record({ events: 'not-an-array' }),
		).resolves.toBeUndefined()
		await expect(tools?.record({})).resolves.toBeUndefined()
	} finally {
		recordUsageSpy.mockRestore()
	}
})
