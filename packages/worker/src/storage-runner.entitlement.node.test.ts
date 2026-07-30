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
	getEstimatedBytes: (storageId: string) => Promise<{ estimatedBytes: number }>,
) {
	return {
		APP_DB: {
			prepare() {
				throw new Error('APP_DB should not be queried when email is absent')
			},
		},
		STORAGE_RUNNER: {
			idFromName: (name: string) => name,
			get: (name: string) => {
				const parts = JSON.parse(name) as [string, string]
				const storageId = parts[1]
				return {
					getEstimatedBytes: () => getEstimatedBytes(storageId),
				}
			},
		},
	} as unknown as Env
}

test('assertStorageRunnerWriteWithinEntitlement retries estimate reads once, fails closed, and waits for peers', async () => {
	mockModule.listUserStorageBucketIds.mockResolvedValue(['bucket-a'])
	const retryOnce = vi
		.fn()
		.mockRejectedValueOnce(new Error('transient DO read failure'))
		.mockResolvedValueOnce({ estimatedBytes: 32 })

	vi.useFakeTimers()
	try {
		const assertion = assertStorageRunnerWriteWithinEntitlement({
			env: createEstimateEnv(() => retryOnce()),
			userId: 'user-1',
			email: null,
			storageId: 'bucket-a',
			requested: 1,
		})
		await vi.advanceTimersByTimeAsync(storageEstimateReadRetryDelayMs)
		await expect(assertion).resolves.toBeUndefined()
		expect(retryOnce).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	const persistentFailure = vi
		.fn()
		.mockRejectedValue(new Error('persistent DO read failure'))
	vi.useFakeTimers()
	try {
		const assertion = assertStorageRunnerWriteWithinEntitlement({
			env: createEstimateEnv(() => persistentFailure()),
			userId: 'user-1',
			email: null,
			storageId: 'bucket-a',
			requested: 1,
		})
		const expectation = expect(assertion).rejects.toThrow(
			'Unable to verify the storage byte entitlement because the bucket estimate for storageId "bucket-a" could not be read after 2 attempts.',
		)
		await vi.advanceTimersByTimeAsync(storageEstimateReadRetryDelayMs)
		await expectation
		expect(persistentFailure).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	const chunkStorageIds = ['fast-fail', 'slow-ok'] as const
	mockModule.listUserStorageBucketIds.mockResolvedValue([...chunkStorageIds])

	let inFlight = 0
	let maxInFlight = 0
	let resolveSlow: (() => void) | undefined
	const slowPending = new Promise<void>((resolve) => {
		resolveSlow = resolve
	})
	const callCounts = new Map<string, number>()

	const getEstimatedBytes = async (storageId: string) => {
		inFlight += 1
		maxInFlight = Math.max(maxInFlight, inFlight)
		const callCount = (callCounts.get(storageId) ?? 0) + 1
		callCounts.set(storageId, callCount)
		try {
			if (storageId === 'fast-fail') {
				if (callCount === 1) {
					// Yield so the peer read is in-flight before this rejects;
					// a sync throw would never overlap and miss the fan-out bug.
					await Promise.resolve()
					throw new Error('fast fail on first attempt')
				}
				return { estimatedBytes: 8 }
			}
			if (storageId === 'slow-ok') {
				if (callCount === 1) {
					await slowPending
				}
				return { estimatedBytes: 16 }
			}
			throw new Error(`Unexpected storageId: ${storageId}`)
		} finally {
			inFlight -= 1
		}
	}

	const peerAssertion = assertStorageRunnerWriteWithinEntitlement({
		env: createEstimateEnv(getEstimatedBytes),
		userId: 'user-1',
		email: null,
		storageId: 'fast-fail',
		requested: 1,
	})

	await vi.waitFor(() => {
		expect(callCounts.get('fast-fail')).toBe(1)
		expect(callCounts.get('slow-ok')).toBe(1)
	})
	expect(maxInFlight).toBe(chunkStorageIds.length)

	// Even after the retry delay elapses, the failed read must not retry while
	// its slow first-attempt peer is still in flight (allSettled must win).
	await new Promise<void>((resolve) => {
		setTimeout(resolve, storageEstimateReadRetryDelayMs + 50)
	})
	expect(callCounts.get('fast-fail')).toBe(1)
	expect(callCounts.get('slow-ok')).toBe(1)

	resolveSlow?.()
	await expect(peerAssertion).resolves.toBeUndefined()

	expect(callCounts.get('fast-fail')).toBe(2)
	expect(callCounts.get('slow-ok')).toBe(1)
	expect(maxInFlight).toBe(chunkStorageIds.length)
})
