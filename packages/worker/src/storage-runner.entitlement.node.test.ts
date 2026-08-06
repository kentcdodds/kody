import { expect, test, vi } from 'vitest'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { storageEstimateReadRetryDelaysMs } from '#worker/storage-runner.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'

const totalRetryDelayMs = storageEstimateReadRetryDelaysMs.reduce(
	(total, delay) => total + delay,
	0,
)
const maxEstimateReadAttempts = storageEstimateReadRetryDelaysMs.length + 1

const mockModule = vi.hoisted(() => ({
	listUserStorageBucketEstimates: vi.fn(),
	readStorageBytesFromUserMeter: vi.fn(async () => 0),
	registerStorageBucket: vi.fn(),
	recordStorageBucketEstimate: vi.fn(),
	maybeRefreshStorageBucketEstimate: vi.fn(),
}))

vi.mock('#worker/storage-buckets/service.ts', () => ({
	listUserStorageBucketEstimates: (...args: Array<unknown>) =>
		mockModule.listUserStorageBucketEstimates(...args),
	registerStorageBucket: (...args: Array<unknown>) =>
		mockModule.registerStorageBucket(...args),
	recordStorageBucketEstimate: (...args: Array<unknown>) =>
		mockModule.recordStorageBucketEstimate(...args),
	maybeRefreshStorageBucketEstimate: (...args: Array<unknown>) =>
		mockModule.maybeRefreshStorageBucketEstimate(...args),
	repoSessionIdFromStorageBucketId: (storageId: string) =>
		storageId.replace(/^repo-session:/, ''),
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
		readStorageBytesFromUserMeter: (...args: Array<unknown>) =>
			mockModule.readStorageBytesFromUserMeter(...args),
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

test('assertStorageRunnerWriteWithinEntitlement retries estimate reads with backoff, fails closed, and waits for peers', async () => {
	mockModule.listUserStorageBucketEstimates.mockResolvedValue([
		{ storageId: 'bucket-a', kind: 'unknown', estimatedBytes: null },
	])
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
		await vi.advanceTimersByTimeAsync(storageEstimateReadRetryDelaysMs[0])
		await expect(assertion).resolves.toBeUndefined()
		expect(retryOnce).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	// The fail-closed error surfaces only after the whole retry policy is
	// exhausted (production showed a single retry losing to transient
	// per-bucket DO estimate-read failures).
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
			`Unable to verify the storage byte entitlement because the bucket estimate for storageId "bucket-a" could not be read after ${maxEstimateReadAttempts} attempts.`,
		)
		await vi.advanceTimersByTimeAsync(totalRetryDelayMs)
		await expectation
		expect(persistentFailure).toHaveBeenCalledTimes(maxEstimateReadAttempts)
	} finally {
		vi.useRealTimers()
	}

	const chunkStorageIds = ['fast-fail', 'slow-ok'] as const
	mockModule.listUserStorageBucketEstimates.mockResolvedValue(
		chunkStorageIds.map((storageId) => ({
			storageId,
			kind: 'unknown',
			estimatedBytes: null,
		})),
	)

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
		setTimeout(resolve, storageEstimateReadRetryDelaysMs[0] + 50)
	})
	expect(callCounts.get('fast-fail')).toBe(1)
	expect(callCounts.get('slow-ok')).toBe(1)

	resolveSlow?.()
	await expect(peerAssertion).resolves.toBeUndefined()

	expect(callCounts.get('fast-fail')).toBe(2)
	expect(callCounts.get('slow-ok')).toBe(1)
	expect(maxInFlight).toBe(chunkStorageIds.length)
})

// Regression for the 2026-07-30 production incidents: a tiny first write of a
// run-ledger value was blocked by "Unable to verify the storage byte
// entitlement because the bucket estimate for storageId 'package:…' could not
// be read after 2 attempts" — a transient estimate-read failure on a PEER
// bucket in a large inventory, different bucket each time. Once a peer's
// estimate is stored in D1, its Durable Object must never be probed (let
// alone block) another bucket's write.
test('peer estimates stay out of the live probe path while D1 + target compose the baseline', async () => {
	const peerStorageIds = Array.from(
		{ length: 40 },
		(_value, index) => `package:peer-${String(index)}`,
	)
	mockModule.listUserStorageBucketEstimates.mockResolvedValue([
		...peerStorageIds.map((storageId) => ({
			storageId,
			kind: 'package',
			estimatedBytes: 64,
		})),
		{ storageId: 'package:target', kind: 'package', estimatedBytes: 128 },
	])
	const probedStorageIds: Array<string> = []
	const getEstimatedBytes = async (storageId: string) => {
		probedStorageIds.push(storageId)
		if (storageId !== 'package:target') {
			throw new Error('peer DO estimate reads are permanently failing')
		}
		return { estimatedBytes: 256 }
	}

	await expect(
		assertStorageRunnerWriteWithinEntitlement({
			env: createEstimateEnv(getEstimatedBytes),
			userId: 'user-1',
			email: null,
			storageId: 'package:target',
			requested: 1,
		}),
	).resolves.toBeUndefined()

	// Only the write target was measured live; no peer fan-out happened.
	expect(probedStorageIds).toEqual(['package:target'])

	const userId = 'user-1'
	const limit = planLimits.free.maxStorageBytes
	mockModule.readStorageBytesFromUserMeter.mockImplementation(
		async (input: { userId: string }) => {
			expect(input.userId).toBe(userId)
			return limit - 100
		},
	)
	mockModule.listUserStorageBucketEstimates.mockResolvedValue([
		{ storageId: 'package:peer', kind: 'package', estimatedBytes: 50 },
		{ storageId: 'package:target', kind: 'package', estimatedBytes: 200 },
	])
	probedStorageIds.length = 0
	const composeEstimate = async (storageId: string) => {
		probedStorageIds.push(storageId)
		return { estimatedBytes: storageId === 'package:target' ? 60 : 50 }
	}

	const denied = await assertStorageRunnerWriteWithinEntitlement({
		env: createEstimateEnv(composeEstimate),
		userId,
		email: null,
		storageId: 'package:target',
		requested: 1,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(isEntitlementLimitError(denied)).toBe(true)
	expect(denied).toMatchObject({
		details: {
			resource: 'storage_bytes',
			current: limit - 100 + 50 + 60,
			limit,
		},
	})
	expect(probedStorageIds).toEqual(['package:target'])
	expect(mockModule.readStorageBytesFromUserMeter).toHaveBeenCalledWith(
		expect.objectContaining({
			userId,
			db: expect.anything(),
		}),
	)
})
