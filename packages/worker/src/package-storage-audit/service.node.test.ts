import { expect, test, vi } from 'vitest'
import type * as PackageRegistryService from '#worker/package-registry/service.ts'
import type * as StorageRunnerModule from '#worker/storage-runner.ts'

const mocks = vi.hoisted(() => ({
	clearPackageOwnedStorageBucket: vi.fn(),
	storageRunnerRpc: vi.fn(),
}))

vi.mock('#worker/package-registry/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageRegistryService>()
	return {
		...actual,
		clearPackageOwnedStorageBucket: (...args: Array<unknown>) =>
			mocks.clearPackageOwnedStorageBucket(...args),
	}
})

vi.mock('#worker/storage-runner.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StorageRunnerModule>()
	return {
		...actual,
		storageRunnerRpc: (...args: Array<unknown>) =>
			mocks.storageRunnerRpc(...args),
	}
})

type BucketRow = {
	userId: string
	storageId: string
	kind: string
	lastSeenAt: string
}

function compareBucketKeys(
	left: Pick<BucketRow, 'userId' | 'storageId'>,
	right: Pick<BucketRow, 'userId' | 'storageId'>,
) {
	const byUser = left.userId.localeCompare(right.userId)
	return byUser === 0 ? left.storageId.localeCompare(right.storageId) : byUser
}

function createAuditEnv(buckets: Array<BucketRow>) {
	return {
		APP_DB: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind(...params: Array<unknown>) {
						return {
							async all<T>() {
								if (
									!normalized.includes('from user_storage_buckets') ||
									!normalized.includes("kind = 'app'")
								) {
									throw new Error(`Unsupported query: ${query}`)
								}
								const hasCursor = normalized.includes('user_id > ?')
								const cursor = hasCursor
									? {
											userId: String(params[0]),
											storageId: String(params[2]),
										}
									: null
								const limit = Number(params[hasCursor ? 3 : 0])
								const rows = buckets
									.filter((row) => row.kind === 'app')
									.filter((row) =>
										cursor ? compareBucketKeys(row, cursor) > 0 : true,
									)
									.sort(compareBucketKeys)
									.slice(0, limit)
									.map(({ userId, storageId, lastSeenAt }) => ({
										userId,
										storageId,
										lastSeenAt,
									}))
								return { results: rows as Array<T> }
							},
						}
					},
				}
			},
		},
	} as unknown as Env
}

function estimate(bytes: number | Error) {
	return {
		async getEstimatedBytes() {
			if (bytes instanceof Error) throw bytes
			return { estimatedBytes: bytes }
		},
	}
}

const { buildPackageStorageAuditReport, cleanupLegacyPackageStorageBuckets } =
	await import('./service.ts')

test('package storage audit verifies only registered legacy app buckets', async () => {
	const env = createAuditEnv([
		{
			userId: 'user-a',
			storageId: 'pkg-empty',
			kind: 'app',
			lastSeenAt: '2026-07-01T00:00:00.000Z',
		},
		{
			userId: 'user-a',
			storageId: 'job:keep',
			kind: 'job',
			lastSeenAt: '2026-07-02T00:00:00.000Z',
		},
		{
			userId: 'user-b',
			storageId: 'pkg-data',
			kind: 'app',
			lastSeenAt: '2026-07-03T00:00:00.000Z',
		},
	])
	mocks.storageRunnerRpc.mockImplementation((input: { storageId: string }) =>
		estimate(input.storageId === 'pkg-empty' ? 4096 : 8192),
	)

	const report = await buildPackageStorageAuditReport({ env, limit: 200 })

	expect(report).toEqual({
		ok: true,
		legacyBuckets: [
			{
				userId: 'user-a',
				storageId: 'pkg-empty',
				lastSeenAt: '2026-07-01T00:00:00.000Z',
				estimatedBytes: 4096,
				probeError: null,
			},
			{
				userId: 'user-b',
				storageId: 'pkg-data',
				lastSeenAt: '2026-07-03T00:00:00.000Z',
				estimatedBytes: 8192,
				probeError: null,
			},
		],
		nextStartAfter: null,
		totals: {
			legacyBuckets: 2,
			nonEmptyLegacyBuckets: 1,
			probeErrors: 0,
			truncated: false,
		},
	})
	expect(mocks.storageRunnerRpc).toHaveBeenCalledTimes(2)
})

test('package storage audit supports keyset paging and probe deadlines', async () => {
	const env = createAuditEnv(
		Array.from({ length: 3 }, (_, index) => ({
			userId: 'user-a',
			storageId: `pkg-${String(index)}`,
			kind: 'app',
			lastSeenAt: '2026-07-01T00:00:00.000Z',
		})),
	)
	mocks.storageRunnerRpc.mockImplementation((input: { storageId: string }) =>
		input.storageId === 'pkg-1'
			? { getEstimatedBytes: () => new Promise(() => {}) }
			: estimate(4096),
	)

	const first = await buildPackageStorageAuditReport({
		env,
		limit: 2,
		budgets: { legacyBucketProbeMs: 10 },
	})
	expect(first.nextStartAfter).toBe(
		JSON.stringify({ userId: 'user-a', storageId: 'pkg-1' }),
	)
	expect(first.totals).toEqual({
		legacyBuckets: 2,
		nonEmptyLegacyBuckets: 0,
		probeErrors: 1,
		truncated: true,
	})

	const second = await buildPackageStorageAuditReport({
		env,
		limit: 2,
		startAfter: first.nextStartAfter,
	})
	expect(second.legacyBuckets.map((row) => row.storageId)).toEqual(['pkg-2'])
	expect(second.nextStartAfter).toBeNull()
})

test('legacy package storage cleanup clears buckets through package cleanup machinery', async () => {
	const env = createAuditEnv([
		{
			userId: 'user-a',
			storageId: 'pkg-ok',
			kind: 'app',
			lastSeenAt: '2026-07-01T00:00:00.000Z',
		},
		{
			userId: 'user-b',
			storageId: 'pkg-failed',
			kind: 'app',
			lastSeenAt: '2026-07-02T00:00:00.000Z',
		},
	])
	mocks.clearPackageOwnedStorageBucket.mockImplementation(
		async (input: { storageId: string }) => input.storageId === 'pkg-ok',
	)

	const report = await cleanupLegacyPackageStorageBuckets({ env, limit: 200 })

	expect(report).toEqual({
		ok: true,
		buckets: [
			{ userId: 'user-a', storageId: 'pkg-ok', cleared: true },
			{ userId: 'user-b', storageId: 'pkg-failed', cleared: false },
		],
		nextStartAfter: null,
		totals: { cleared: 1, failed: 1, truncated: false },
	})
	expect(mocks.clearPackageOwnedStorageBucket).toHaveBeenCalledWith({
		env,
		userId: 'user-a',
		packageId: 'pkg-ok',
		storageId: 'pkg-ok',
	})
})
