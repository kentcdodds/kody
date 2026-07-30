import { expect, test, vi } from 'vitest'
import type * as EntitlementsService from '#worker/entitlements/service.ts'

const mockModule = vi.hoisted(() => ({
	listUserStorageBucketIds: vi.fn(async () => ['bucket-a', 'bucket-b']),
	readUserD1StorageBytes: vi.fn(async () => 0),
	registerStorageBucket: vi.fn(),
	getEstimatedBytes: vi.fn(async () => ({ estimatedBytes: 64 })),
}))

vi.mock('#worker/storage-buckets/service.ts', () => ({
	listUserStorageBucketIds: (...args: Array<unknown>) =>
		mockModule.listUserStorageBucketIds(...args),
	registerStorageBucket: (...args: Array<unknown>) =>
		mockModule.registerStorageBucket(...args),
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
	mockModule.listUserStorageBucketIds.mockClear()
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

	expect(mockModule.listUserStorageBucketIds).not.toHaveBeenCalled()
	expect(mockModule.getEstimatedBytes).not.toHaveBeenCalled()
})

test('writable storage_sql still enforces entitlement for mutating SQL', async () => {
	mockModule.getEstimatedBytes.mockClear()
	mockModule.listUserStorageBucketIds.mockClear()
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

	expect(mockModule.listUserStorageBucketIds).toHaveBeenCalledTimes(1)
	// Inventoried buckets plus the not-yet-registered target id.
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(3)
})

test('entitlement run cache pays the fan-out once across mutating writes', async () => {
	mockModule.getEstimatedBytes.mockClear()
	mockModule.listUserStorageBucketIds.mockClear()
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

	expect(mockModule.listUserStorageBucketIds).toHaveBeenCalledTimes(1)
	expect(mockModule.getEstimatedBytes).toHaveBeenCalledTimes(3)
	expect(cache.reservedBytes).toBe(30)
})

test('entitlement run cache drops a rejected baseline so later writes retry', async () => {
	mockModule.listUserStorageBucketIds.mockResolvedValue(['bucket-a'])
	mockModule.getEstimatedBytes
		.mockRejectedValueOnce(new Error('transient estimate failure'))
		.mockRejectedValueOnce(new Error('transient estimate failure'))
		.mockResolvedValue({ estimatedBytes: 64 })
	const cache = createStorageBytesEntitlementRunCache()
	const env = createEstimateEnv()

	await expect(
		assertStorageRunnerWriteWithinEntitlement({
			env,
			userId: 'user-1',
			email: null,
			storageId: 'bucket-a',
			requested: 1,
			cache,
		}),
	).rejects.toThrow(/could not be read/)
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
