import { expect, test, vi } from 'vitest'
import {
	backupBlobKey,
	stagingR2IndexKey,
	stagingStorageDumpKey,
	stagingSummaryKey,
	type StorageDumpEntry,
} from '@kody-internal/shared/backup-staging.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import {
	__testOnlyCreateInitialProgress,
	runDrExportTick,
	shouldRunDrExportCron,
} from '#worker/dr/exporter.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'
import { type DrBackupS3Client } from '#worker/dr/backup-s3.ts'

const storageMocks = vi.hoisted(() => ({
	exportStorage: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: () => ({
		exportStorage: storageMocks.exportStorage,
	}),
}))

function createMemoryS3() {
	const objects = new Map<string, Uint8Array>()
	const client: DrBackupS3Client = {
		async head(key) {
			return { exists: objects.has(key), status: objects.has(key) ? 200 : 404 }
		},
		async getText(key) {
			const bytes = objects.get(key)
			return bytes ? new TextDecoder().decode(bytes) : null
		},
		async getBytes(key) {
			return objects.get(key) ?? null
		},
		async put(key, body) {
			const bytes =
				typeof body === 'string' ? new TextEncoder().encode(body) : body
			objects.set(key, bytes)
		},
	}
	return { client, objects }
}

function createDb(results: {
	jobs?: Array<{ userId: string; storageId: string }>
	archived?: Array<{ userId: string; storageId: string }>
	runtime?: Array<{ userId: string; storageId: string }>
	packages?: Array<{ userId: string; storageId: string }>
	services?: Array<{
		userId: string
		packageId: string
		serviceName: string
	}>
	artifacts?: Array<{
		sourceId: string
		userId: string
		entityKind: string
		entityId: string
		publishedCommit: string
	}>
}) {
	return {
		prepare(sql: string) {
			return {
				all: async () => {
					if (sql.includes('FROM jobs')) {
						return { results: results.jobs ?? [] }
					}
					if (sql.includes('FROM archived_job_artifacts')) {
						return { results: results.archived ?? [] }
					}
					if (
						sql.includes("surface = 'service'") ||
						sql.includes('surface = "service"')
					) {
						return { results: results.services ?? [] }
					}
					if (sql.includes('FROM package_runtime_runs')) {
						return { results: results.runtime ?? [] }
					}
					if (sql.includes('FROM saved_packages')) {
						return { results: results.packages ?? [] }
					}
					if (sql.includes('FROM entity_sources')) {
						return { results: results.artifacts ?? [] }
					}
					return { results: [] }
				},
			}
		},
	} as unknown as D1Database
}

function createR2(objects: Record<string, Uint8Array>) {
	const entries = Object.entries(objects)
	return {
		async list() {
			return {
				objects: entries.map(([key, value]) => ({
					key,
					size: value.byteLength,
					uploaded: new Date(),
					etag: 'etag',
					httpEtag: 'etag',
					checksums: {},
					version: 'v1',
				})),
				truncated: false,
				cursor: '',
			}
		},
		async get(key: string) {
			const value = objects[key]
			if (!value) return null
			return {
				arrayBuffer: async () =>
					value.buffer.slice(
						value.byteOffset,
						value.byteOffset + value.byteLength,
					),
			}
		},
	} as unknown as R2Bucket
}

test('shouldRunDrExportCron gates to the nightly 00:30–02:10 UTC window', () => {
	expect(shouldRunDrExportCron(new Date('2026-07-23T00:25:00.000Z'))).toBe(
		false,
	)
	expect(shouldRunDrExportCron(new Date('2026-07-23T00:30:00.000Z'))).toBe(true)
	expect(shouldRunDrExportCron(new Date('2026-07-23T01:45:00.000Z'))).toBe(true)
	expect(shouldRunDrExportCron(new Date('2026-07-23T02:10:00.000Z'))).toBe(true)
	expect(shouldRunDrExportCron(new Date('2026-07-23T02:15:00.000Z'))).toBe(
		false,
	)
})

test('exporter progresses phases with mocked bindings and S3, writing summary last', async () => {
	storageMocks.exportStorage.mockReset()
	storageMocks.exportStorage.mockResolvedValue({
		entries: [{ key: 'alpha', value: { n: 1 } }],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 10,
	})
	const { client, objects } = createMemoryS3()
	const blobBytes = new TextEncoder().encode('email-bytes')
	const kvSnapshot = JSON.stringify({ version: 1, files: { 'a.ts': 'x' } })
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_COMMIT_SHA: 'abcdef1',
		APP_DB: createDb({
			jobs: [{ userId: 'user-a', storageId: 'job:1' }],
			artifacts: [
				{
					sourceId: 'src-1',
					userId: 'user-a',
					entityKind: 'package',
					entityId: 'pkg-1',
					publishedCommit: 'commit-1',
				},
			],
		}),
		EMAIL_BLOBS: createR2({ 'raw/one': blobBytes }),
		COMMUNITY_ASSETS: createR2({}),
		BUNDLE_ARTIFACTS_KV: {
			get: async (key: string) =>
				key === 'source-snapshot:v1:src-1:commit-1' ? kvSnapshot : null,
		},
		STORAGE_RUNNER: {},
	} as unknown as Env

	const now = new Date('2026-07-23T01:00:00.000Z')
	const first = await runDrExportTick({
		env,
		now,
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(first.skipped).toBe(false)
	expect(first.summaryWritten).toBe(true)
	expect(first.phase).toBe('done')

	const day = '2026-07-23'
	const identity = encodeStorageIdentity('user-a', 'job:1')
	const dumpKey = stagingStorageDumpKey(day, identity)
	const dump = await client.getText(dumpKey)
	expect(dump).toBeTruthy()
	const dumpEntry = JSON.parse(dump!.trim()) as StorageDumpEntry
	expect(dumpEntry).toEqual({
		key: 'alpha',
		valueJson: JSON.stringify({ n: 1 }),
	})
	const dumpDigest = await sha256Hex(dump!)
	expect(dumpDigest).toMatch(/^[0-9a-f]{64}$/)

	const emailIndex = await client.getText(stagingR2IndexKey(day, 'email-blobs'))
	expect(emailIndex).toContain('raw/one')
	const blobDigest = await sha256Hex(blobBytes)
	expect(objects.has(backupBlobKey(blobDigest))).toBe(true)

	const summary = JSON.parse((await client.getText(stagingSummaryKey(day)))!)
	expect(summary.day).toBe(day)
	expect(summary.storageIndex.sha256).toMatch(/^[0-9a-f]{64}$/)
	expect(summary.blobsWritten).toBeGreaterThanOrEqual(1)
})

test('exporter resumes from progress cursor across ticks when budget is exhausted', async () => {
	storageMocks.exportStorage.mockReset()
	storageMocks.exportStorage.mockResolvedValue({
		entries: [{ key: 'k', value: 1 }],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 1,
	})
	const { client } = createMemoryS3()
	let nowMs = 1_000_000
	const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
	const originalPut = client.put.bind(client)
	client.put = async (key, body, contentType) => {
		await originalPut(key, body, contentType)
		// After the first storage dump lands, exhaust the tick budget so the
		// second storage identity is deferred to the next cron tick.
		if (key.includes('/storage/') && key.endsWith('.ndjson')) {
			nowMs += 50_000
		}
	}
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_DB: createDb({
			jobs: [
				{ userId: 'user-a', storageId: 'job:1' },
				{ userId: 'user-a', storageId: 'job:2' },
			],
		}),
		EMAIL_BLOBS: createR2({}),
		COMMUNITY_ASSETS: createR2({}),
		BUNDLE_ARTIFACTS_KV: { get: async () => null },
		STORAGE_RUNNER: {},
	} as unknown as Env
	const now = new Date('2026-07-23T01:00:00.000Z')

	try {
		const tick1 = await runDrExportTick({
			env,
			now,
			timeBudgetMs: 20_000,
			s3: client,
		})
		expect(tick1.timeBudgetExhausted).toBe(true)
		expect(tick1.summaryWritten).toBe(false)
		expect(tick1.storageDumpsCompleted).toBe(1)

		nowMs = 1_000_000
		const tick2 = await runDrExportTick({
			env,
			now,
			timeBudgetMs: 60_000,
			s3: client,
		})
		expect(tick2.summaryWritten).toBe(true)
		expect(storageMocks.exportStorage.mock.calls.length).toBe(2)
	} finally {
		dateNow.mockRestore()
	}
})

test('blob dedupe skips PUT when HEAD reports the object already exists', async () => {
	storageMocks.exportStorage.mockReset()
	storageMocks.exportStorage.mockResolvedValue({
		entries: [],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 0,
	})
	const blobBytes = new TextEncoder().encode('same-bytes')
	const digest = await sha256Hex(blobBytes)
	const { client, objects } = createMemoryS3()
	await client.put(backupBlobKey(digest), blobBytes)
	const putsBefore = objects.size
	const headSpy = vi.spyOn(client, 'head')
	const putSpy = vi.spyOn(client, 'put')

	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_DB: createDb({}),
		EMAIL_BLOBS: createR2({ 'raw/dup': blobBytes }),
		COMMUNITY_ASSETS: createR2({}),
		BUNDLE_ARTIFACTS_KV: { get: async () => null },
		STORAGE_RUNNER: {},
	} as unknown as Env

	const result = await runDrExportTick({
		env,
		now: new Date('2026-07-23T01:00:00.000Z'),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result.blobsReused).toBeGreaterThanOrEqual(1)
	expect(headSpy).toHaveBeenCalledWith(backupBlobKey(digest))
	const blobPuts = putSpy.mock.calls.filter(
		([key]) => key === backupBlobKey(digest),
	)
	expect(blobPuts).toHaveLength(0)
	expect(objects.size).toBeGreaterThanOrEqual(putsBefore)
})

test('initial progress shape includes phase and cursors', () => {
	const progress = __testOnlyCreateInitialProgress(
		'2026-07-23',
		new Date('2026-07-23T01:00:00.000Z'),
	)
	expect(progress.phase).toBe('storage')
	expect(progress.storageIndex).toBe(0)
	expect(progress.storagePageStartAfter).toBeNull()
	expect(progress.r2LabelIndex).toBe(0)
	expect(progress.artifactsIndex).toBe(0)
})
