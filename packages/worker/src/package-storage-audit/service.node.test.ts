import { expect, test, vi } from 'vitest'
import type * as StorageRunnerModule from '#worker/storage-runner.ts'

const mockModule = vi.hoisted(() => ({
	storageRunnerRpc: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StorageRunnerModule>()
	return {
		...actual,
		storageRunnerRpc: (...args: Array<unknown>) =>
			mockModule.storageRunnerRpc(...args),
	}
})

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

type SavedPackageRow = {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
	hasApp: number
}

type StorageBucketRow = {
	userId: string
	storageId: string
	kind: string
	lastSeenAt: string
}

function packageOwnershipKey(userId: string, packageId: string) {
	return `${userId}\0${packageId}`
}

function createAuditTestEnv(input: {
	packages: Array<SavedPackageRow>
	buckets: Array<StorageBucketRow>
}) {
	function normalize(query: string) {
		return query.replace(/\s+/g, ' ').trim().toLowerCase()
	}

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalized = normalize(query)
		return {
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async first() {
				throw new Error(`Unsupported first query: ${query}`)
			},
			async all<T>() {
				if (
					normalized.includes('from saved_packages') &&
					normalized.includes('has_app = 1')
				) {
					const limit = Number(params[0] ?? input.packages.length)
					const rows = input.packages
						.filter((row) => row.hasApp === 1)
						.sort((left, right) => {
							const byUser = left.userId.localeCompare(right.userId)
							if (byUser !== 0) return byUser
							return left.packageId.localeCompare(right.packageId)
						})
						.slice(0, limit)
						.map((row) => ({
							userId: row.userId,
							packageId: row.packageId,
							kodyId: row.kodyId,
							sourceId: row.sourceId,
						}))
					return {
						results: rows,
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				if (
					normalized.includes('from user_storage_buckets b') &&
					normalized.includes("kind = 'app'") &&
					normalized.includes('p.user_id = b.user_id')
				) {
					const limit = Number(params[0] ?? Number.POSITIVE_INFINITY)
					const ownedKeys = new Set(
						input.packages.map((row) =>
							packageOwnershipKey(row.userId, row.packageId),
						),
					)
					const rows = input.buckets
						.filter(
							(row) =>
								row.kind === 'app' &&
								!ownedKeys.has(packageOwnershipKey(row.userId, row.storageId)),
						)
						.sort((left, right) => {
							const byUser = left.userId.localeCompare(right.userId)
							if (byUser !== 0) return byUser
							return left.storageId.localeCompare(right.storageId)
						})
						.slice(0, limit)
						.map((row) => ({
							userId: row.userId,
							storageId: row.storageId,
							lastSeenAt: row.lastSeenAt,
						}))
					return {
						results: rows,
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				throw new Error(`Unsupported all query: ${query}`)
			},
			async run() {
				throw new Error(`Unsupported run query: ${query}`)
			},
		}
	}

	return {
		APP_DB: {
			prepare(query: string) {
				return createStatement(query)
			},
		},
	} as unknown as Env
}

const { buildPackageStorageAuditReport } = await import('./service.ts')

function stubEstimate(bytes: number | Error) {
	return {
		getEstimatedBytes: async () => {
			if (bytes instanceof Error) throw bytes
			return { estimatedBytes: bytes }
		},
	}
}

test('package storage audit report probes legacy buckets, ambient imports, and orphans', async () => {
	const packages: Array<SavedPackageRow> = [
		{
			userId: 'user-a',
			packageId: 'pkg-empty',
			kodyId: 'empty-app',
			sourceId: 'source-empty',
			hasApp: 1,
		},
		{
			userId: 'user-a',
			packageId: 'pkg-data',
			kodyId: 'data-app',
			sourceId: 'source-data',
			hasApp: 1,
		},
		{
			userId: 'user-b',
			packageId: 'pkg-ambient',
			kodyId: 'ambient-app',
			sourceId: 'source-ambient',
			hasApp: 1,
		},
		{
			userId: 'user-b',
			packageId: 'pkg-probe-error',
			kodyId: 'probe-error-app',
			sourceId: 'source-probe-error',
			hasApp: 1,
		},
		{
			userId: 'user-b',
			packageId: 'pkg-scan-error',
			kodyId: 'scan-error-app',
			sourceId: 'source-scan-error',
			hasApp: 1,
		},
		{
			userId: 'user-a',
			packageId: 'pkg-no-app',
			kodyId: 'no-app',
			sourceId: 'source-no-app',
			hasApp: 0,
		},
	]
	const buckets: Array<StorageBucketRow> = [
		{
			userId: 'user-a',
			storageId: 'pkg-empty',
			kind: 'app',
			lastSeenAt: '2026-07-01T00:00:00.000Z',
		},
		{
			userId: 'user-z',
			storageId: 'deleted-pkg',
			kind: 'app',
			lastSeenAt: '2026-07-02T00:00:00.000Z',
		},
		{
			// Cross-user collision: storage_id matches user-b's package, but the
			// bucket belongs to user-a, so it must still count as an orphan.
			userId: 'user-a',
			storageId: 'pkg-ambient',
			kind: 'app',
			lastSeenAt: '2026-07-02T12:00:00.000Z',
		},
		{
			userId: 'user-a',
			storageId: 'job:still-here',
			kind: 'job',
			lastSeenAt: '2026-07-03T00:00:00.000Z',
		},
	]
	const env = createAuditTestEnv({ packages, buckets })

	mockModule.storageRunnerRpc.mockImplementation(
		(input: { storageId: string }) => {
			if (input.storageId === 'pkg-empty') return stubEstimate(4096)
			if (input.storageId === 'pkg-data') return stubEstimate(8192)
			if (input.storageId === 'pkg-ambient') return stubEstimate(4096)
			if (input.storageId === 'pkg-probe-error') {
				return stubEstimate(new Error('DO unavailable'))
			}
			if (input.storageId === 'pkg-scan-error') return stubEstimate(4096)
			throw new Error(`Unexpected storageId: ${input.storageId}`)
		},
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (
				input.sourceId === 'source-empty' ||
				input.sourceId === 'source-data' ||
				input.sourceId === 'source-probe-error'
			) {
				return {
					files: {
						'index.ts': `import { packageStorage } from 'kody:runtime'\nexport const x = packageStorage()\n`,
					},
				}
			}
			if (input.sourceId === 'source-ambient') {
				return {
					files: {
						'app.ts': `import { storage } from 'kody:runtime'\nexport const read = () => storage.get('k')\n`,
						'helpers.ts': `import { kody } from 'kody:runtime'\nexport const noop = () => kody\n`,
					},
				}
			}
			if (input.sourceId === 'source-scan-error') {
				throw new Error('source missing')
			}
			throw new Error(`Unexpected sourceId: ${input.sourceId}`)
		},
	)

	const body = await buildPackageStorageAuditReport({
		env,
		baseUrl: 'https://example.com',
		limit: 200,
	})
	expect(body).toMatchObject({
		ok: true,
		totals: {
			appPackages: 5,
			nonEmptyLegacyBuckets: 1,
			packagesWithAmbientImports: 1,
			orphanAppBuckets: 2,
			truncated: false,
			orphanTruncated: false,
		},
		orphanAppBuckets: [
			{
				userId: 'user-a',
				storageId: 'pkg-ambient',
				lastSeenAt: '2026-07-02T12:00:00.000Z',
			},
			{
				userId: 'user-z',
				storageId: 'deleted-pkg',
				lastSeenAt: '2026-07-02T00:00:00.000Z',
			},
		],
	})

	const byId = new Map(body.packages.map((row) => [row.packageId, row]))
	expect(byId.get('pkg-empty')).toMatchObject({
		userId: 'user-a',
		kodyId: 'empty-app',
		legacyBucketBytes: 4096,
		legacyBucketProbeError: null,
		ambientStorageImportFiles: [],
		sourceScanError: null,
	})
	expect(byId.get('pkg-data')).toMatchObject({
		legacyBucketBytes: 8192,
		legacyBucketProbeError: null,
		ambientStorageImportFiles: [],
		sourceScanError: null,
	})
	expect(byId.get('pkg-ambient')).toMatchObject({
		userId: 'user-b',
		legacyBucketBytes: 4096,
		ambientStorageImportFiles: ['app.ts'],
		sourceScanError: null,
	})
	expect(byId.get('pkg-probe-error')).toMatchObject({
		legacyBucketBytes: null,
		legacyBucketProbeError: 'DO unavailable',
		ambientStorageImportFiles: [],
		sourceScanError: null,
	})
	expect(byId.get('pkg-scan-error')).toMatchObject({
		legacyBucketBytes: 4096,
		legacyBucketProbeError: null,
		ambientStorageImportFiles: [],
		sourceScanError: 'source missing',
	})

	for (const call of mockModule.storageRunnerRpc.mock.calls) {
		const arg = call[0] as { userId: string; storageId: string }
		const pkg = packages.find((row) => row.packageId === arg.storageId)
		expect(pkg).toBeTruthy()
		expect(arg.userId).toBe(pkg?.userId)
	}
})

test('package storage audit report supports limit truncation', async () => {
	const packages = Array.from({ length: 4 }, (_, index) => ({
		userId: 'user-a',
		packageId: `pkg-${String(index)}`,
		kodyId: `app-${String(index)}`,
		sourceId: `source-${String(index)}`,
		hasApp: 1 as const,
	}))
	const env = createAuditTestEnv({ packages, buckets: [] })
	mockModule.storageRunnerRpc.mockImplementation(() => stubEstimate(0))
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		files: { 'index.ts': 'export const ok = true\n' },
	})

	await expect(
		buildPackageStorageAuditReport({
			env,
			baseUrl: 'https://example.com',
			limit: 2,
		}),
	).resolves.toMatchObject({
		ok: true,
		packages: [{ packageId: 'pkg-0' }, { packageId: 'pkg-1' }],
		totals: {
			appPackages: 2,
			nonEmptyLegacyBuckets: 0,
			packagesWithAmbientImports: 0,
			orphanAppBuckets: 0,
			truncated: true,
			orphanTruncated: false,
		},
	})
})
