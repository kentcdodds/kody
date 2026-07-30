import { expect, test, vi } from 'vitest'
import { EntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'

const mockModule = vi.hoisted(() => ({
	listUserStorageBucketEstimates: vi.fn(
		async (): Promise<
			Array<{ storageId: string; estimatedBytes: number | null }>
		> => [
			{ storageId: 'bucket-a', estimatedBytes: null },
			{ storageId: 'bucket-b', estimatedBytes: null },
		],
	),
	readUserD1StorageBytes: vi.fn(async () => 0),
	registerStorageBucket: vi.fn(),
	recordStorageBucketEstimate: vi.fn(),
	maybeRefreshStorageBucketEstimate: vi.fn(),
	getEstimatedBytes: vi.fn(async () => ({ estimatedBytes: 64 })),
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
	storageBucketKindFromStorageId: (storageId: string) => {
		if (storageId.startsWith('package:')) return 'package'
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

const {
	assertStorageRunnerWriteWithinEntitlement,
	createStorageBytesEntitlementRunCache,
	createStorageKodyTools,
	isReadOnlyStorageSqlQuery,
	storageEstimateReadRetryDelaysMs,
} = await import('#worker/storage-runner.ts')

function createEstimateEnv() {
	return {
		APP_DB: {
			prepare() {
				throw new Error('APP_DB should not be queried when email is absent')
			},
		},
		STORAGE_RUNNER: {
			idFromName: (name: string) => name,
			get: () => ({
				getEstimatedBytes: () => mockModule.getEstimatedBytes(),
				sqlQuery: async (input: {
					query: string
					params?: Array<unknown>
					writable?: boolean
				}) => ({
					columns: [],
					rows: [],
					rowCount: 0,
					rowsRead: 0,
					rowsWritten: input.writable ? 1 : 0,
				}),
				getValue: async ({ key }: { key: string }) => ({
					key,
					value: null,
				}),
				setValue: async ({ key }: { key: string }) => ({
					ok: true as const,
					key,
				}),
				deleteValue: async () => ({
					ok: true as const,
					key: 'x',
					deleted: true,
				}),
				clearStorage: async () => ({ ok: true as const }),
				listValues: async () => ({
					entries: [],
					estimatedBytes: 0,
					truncated: false,
					nextStartAfter: null,
					pageSize: 50,
				}),
			}),
		},
	} as unknown as Env
}

test('isReadOnlyStorageSqlQuery accepts single SELECT/EXPLAIN/PRAGMA only', () => {
	expect(isReadOnlyStorageSqlQuery('SELECT 1')).toBe(true)
	expect(isReadOnlyStorageSqlQuery('  explain query plan select 1')).toBe(true)
	expect(isReadOnlyStorageSqlQuery('PRAGMA table_info(skills)')).toBe(true)
	expect(isReadOnlyStorageSqlQuery('CREATE TABLE skills (id TEXT)')).toBe(false)
	expect(
		isReadOnlyStorageSqlQuery('SELECT 1; CREATE TABLE skills (id TEXT)'),
	).toBe(false)
	expect(isReadOnlyStorageSqlQuery('')).toBe(false)
})

test('writable storage_sql skips entitlement fan-out for read-only queries', async () => {
	mockModule.getEstimatedBytes.mockClear()
	mockModule.listUserStorageBucketEstimates.mockClear()
	mockModule.maybeRefreshStorageBucketEstimate.mockClear()
	const tools = createStorageKodyTools({
		env: createEstimateEnv(),
		userId: 'user-1',
		email: null,
		storageId: 'package:skills',
		writable: true,
	})

	await expect(
		tools.storage_sql({
			query: 'SELECT id FROM skills',
			params: [],
			writable: true,
		}),
	).resolves.toMatchObject({ rowCount: 0 })

	expect(mockModule.listUserStorageBucketEstimates).not.toHaveBeenCalled()
	expect(mockModule.getEstimatedBytes).not.toHaveBeenCalled()
	expect(mockModule.maybeRefreshStorageBucketEstimate).not.toHaveBeenCalled()
})

test('writable storage_sql still enforces entitlement for mutating SQL', async () => {
	mockModule.getEstimatedBytes.mockClear()
	mockModule.listUserStorageBucketEstimates.mockClear()
	mockModule.recordStorageBucketEstimate.mockClear()
	mockModule.maybeRefreshStorageBucketEstimate.mockClear()
	const tools = createStorageKodyTools({
		env: createEstimateEnv(),
		userId: 'user-1',
		email: null,
		storageId: 'package:skills',
		writable: true,
	})

	await expect(
		tools.storage_sql({
			query: 'CREATE TABLE IF NOT EXISTS skills (id TEXT)',
			params: [],
			writable: true,
		}),
	).resolves.toMatchObject({ rowsWritten: 1 })

	expect(mockModule.listUserStorageBucketEstimates).toHaveBeenCalledTimes(1)
	// Inventoried buckets without stored estimates plus the
	// not-yet-registered target id.
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(3)
	// Every probed value is persisted for the next baseline read.
	expect(mockModule.recordStorageBucketEstimate).toHaveBeenCalledTimes(3)
	// The mutating write also schedules a post-write estimate refresh.
	expect(mockModule.maybeRefreshStorageBucketEstimate).toHaveBeenCalledTimes(1)
})

test('mutating entitlement probes only the target bucket when stored estimates exist', async () => {
	mockModule.getEstimatedBytes.mockClear()
	mockModule.listUserStorageBucketEstimates.mockClear()
	mockModule.recordStorageBucketEstimate.mockClear()
	mockModule.listUserStorageBucketEstimates.mockResolvedValueOnce([
		{ storageId: 'bucket-a', estimatedBytes: 100 },
		{ storageId: 'bucket-b', estimatedBytes: 200 },
		{ storageId: 'package:skills', estimatedBytes: 999 },
	])

	await expect(
		assertStorageRunnerWriteWithinEntitlement({
			env: createEstimateEnv(),
			userId: 'user-1',
			email: null,
			storageId: 'package:skills',
			requested: 1,
		}),
	).resolves.toBeUndefined()

	// Only the bucket being written is probed live; bucket-a and bucket-b
	// contribute their stored D1 estimates without any DO fan-out.
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(1)
	expect(mockModule.recordStorageBucketEstimate).toHaveBeenCalledTimes(1)
	expect(mockModule.recordStorageBucketEstimate).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: 'user-1',
		storageId: 'package:skills',
		estimatedBytes: 64,
	})
})

test('stored bucket estimates count toward the storage-byte limit without probes', async () => {
	mockModule.getEstimatedBytes.mockClear()
	mockModule.listUserStorageBucketEstimates.mockClear()
	const maxStorageBytes = planLimits.max.maxStorageBytes
	mockModule.listUserStorageBucketEstimates.mockResolvedValueOnce([
		{ storageId: 'bucket-a', estimatedBytes: maxStorageBytes },
	])

	const denied = await assertStorageRunnerWriteWithinEntitlement({
		env: createEstimateEnv(),
		userId: 'user-1',
		email: null,
		storageId: 'package:skills',
		requested: 1,
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(denied instanceof EntitlementLimitError)) {
		throw new Error('Expected an EntitlementLimitError.')
	}
	expect(denied.details).toMatchObject({
		resource: 'storage_bytes',
		limit: maxStorageBytes,
		// bucket-a's stored estimate plus the live probe of the target bucket.
		current: maxStorageBytes + 64,
	})
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(1)
})

test('entitlement run cache pays the fan-out once across mutating writes', async () => {
	mockModule.getEstimatedBytes.mockClear()
	mockModule.listUserStorageBucketEstimates.mockClear()
	const cache = createStorageBytesEntitlementRunCache()
	const env = createEstimateEnv()

	await assertStorageRunnerWriteWithinEntitlement({
		env,
		userId: 'user-1',
		email: null,
		storageId: 'package:skills',
		requested: 10,
		cache,
	})
	await assertStorageRunnerWriteWithinEntitlement({
		env,
		userId: 'user-1',
		email: null,
		storageId: 'package:skills',
		requested: 10,
		cache,
	})
	await assertStorageRunnerWriteWithinEntitlement({
		env,
		userId: 'user-1',
		email: null,
		storageId: 'package:skills',
		requested: 10,
		cache,
	})

	expect(mockModule.listUserStorageBucketEstimates).toHaveBeenCalledTimes(1)
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(3)
	expect(cache.reservedBytes).toBe(30)
})

test('entitlement run cache drops a rejected baseline so later writes retry', async () => {
	mockModule.listUserStorageBucketEstimates.mockResolvedValue([
		{ storageId: 'bucket-a', estimatedBytes: null },
	])
	mockModule.getEstimatedBytes.mockClear()
	// Exhaust the whole retry policy so the baseline read fails closed.
	for (
		let attempt = 0;
		attempt <= storageEstimateReadRetryDelaysMs.length;
		attempt += 1
	) {
		mockModule.getEstimatedBytes.mockRejectedValueOnce(
			new Error('transient estimate failure'),
		)
	}
	mockModule.getEstimatedBytes.mockResolvedValue({ estimatedBytes: 64 })
	const cache = createStorageBytesEntitlementRunCache()
	const env = createEstimateEnv()

	vi.useFakeTimers()
	try {
		const firstAssertion = assertStorageRunnerWriteWithinEntitlement({
			env,
			userId: 'user-1',
			email: null,
			storageId: 'bucket-a',
			requested: 1,
			cache,
		})
		const expectation =
			expect(firstAssertion).rejects.toThrow(/could not be read/)
		await vi.advanceTimersByTimeAsync(
			storageEstimateReadRetryDelaysMs.reduce(
				(total, delay) => total + delay,
				0,
			),
		)
		await expectation
	} finally {
		vi.useRealTimers()
	}
	expect(cache.baseline).toBeNull()

	await expect(
		assertStorageRunnerWriteWithinEntitlement({
			env,
			userId: 'user-1',
			email: null,
			storageId: 'bucket-a',
			requested: 1,
			cache,
		}),
	).resolves.toBeUndefined()
	expect(cache.reservedBytes).toBe(1)
})
