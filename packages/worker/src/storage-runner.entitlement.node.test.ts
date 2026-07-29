import { expect, test, vi } from 'vitest'
import { storageEstimateReadRetryDelayMs } from '#worker/storage-runner.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'

const mockModule = vi.hoisted(() => ({
	listUserStorageBucketIds: vi.fn(),
	readUserD1StorageBytes: vi.fn(async () => 0),
	registerStorageBucket: vi.fn(),
}))

vi.mock('#worker/storage-buckets/service.ts', () => ({
	listUserStorageBucketIds: (...args: Array<unknown>) =>
		mockModule.listUserStorageBucketIds(...args),
	registerStorageBucket: (...args: Array<unknown>) =>
		mockModule.registerStorageBucket(...args),
	storageBucketKindFromStorageId: (storageId: string) => {
		if (storageId.startsWith('job:')) return 'job'
		if (storageId.startsWith('exec:')) return 'execute'
		if (storageId.startsWith('package:')) return 'package'
		if (storageId.startsWith('service:')) return 'service'
		return 'unknown'
	},
	flushStorageBucketRegistrationsForTests: async () => undefined,
	clearStorageBucketRegistrationDedupeForTests: () => undefined,
	listPlatformStorageBuckets: async () => [],
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementsService>()
	return {
		...actual,
		readUserD1StorageBytes: (...args: Array<unknown>) =>
			mockModule.readUserD1StorageBytes(...args),
	}
})

const { assertStorageRunnerWriteWithinEntitlement } =
	await import('#worker/storage-runner.ts')

function createEstimateEnv(
	getEstimatedBytes: () => Promise<{ estimatedBytes: number }>,
) {
	return {
		APP_DB: {
			prepare() {
				throw new Error('APP_DB should not be queried when email is absent')
			},
		},
		STORAGE_RUNNER: {
			idFromName: (name: string) => name,
			get: () => ({
				getEstimatedBytes,
			}),
		},
	} as unknown as Env
}

test('assertStorageRunnerWriteWithinEntitlement retries a failed estimate chunk once', async () => {
	mockModule.listUserStorageBucketIds.mockResolvedValue(['bucket-a'])
	const getEstimatedBytes = vi
		.fn()
		.mockRejectedValueOnce(new Error('transient DO read failure'))
		.mockResolvedValueOnce({ estimatedBytes: 32 })

	vi.useFakeTimers()
	try {
		const assertion = assertStorageRunnerWriteWithinEntitlement({
			env: createEstimateEnv(getEstimatedBytes),
			userId: 'user-1',
			email: null,
			storageId: 'bucket-a',
			requested: 1,
		})
		await vi.advanceTimersByTimeAsync(storageEstimateReadRetryDelayMs)
		await expect(assertion).resolves.toBeUndefined()
		expect(getEstimatedBytes).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}
})

test('assertStorageRunnerWriteWithinEntitlement fails closed when the retry also fails', async () => {
	mockModule.listUserStorageBucketIds.mockResolvedValue(['bucket-a'])
	const getEstimatedBytes = vi
		.fn()
		.mockRejectedValue(new Error('persistent DO read failure'))

	vi.useFakeTimers()
	try {
		const assertion = assertStorageRunnerWriteWithinEntitlement({
			env: createEstimateEnv(getEstimatedBytes),
			userId: 'user-1',
			email: null,
			storageId: 'bucket-a',
			requested: 1,
		})
		const expectation = expect(assertion).rejects.toThrow(
			'Unable to verify the storage byte entitlement because a bucket estimate could not be read.',
		)
		await vi.advanceTimersByTimeAsync(storageEstimateReadRetryDelayMs)
		await expectation
		expect(getEstimatedBytes).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}
})
