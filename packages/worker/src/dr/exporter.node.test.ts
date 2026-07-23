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
	drExportMaxObjectBytes,
	drExportMaxStorageDumpBufferBytes,
	runDrExportTick,
	shouldRunDrExportCron,
} from '#worker/dr/exporter.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'
import {
	DrBackupPreconditionFailedError,
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'

const storageMocks = vi.hoisted(() => ({
	exportStorage: vi.fn(),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: () => ({
		exportStorage: storageMocks.exportStorage,
	}),
}))

function etagFor(bytes: Uint8Array) {
	let hash = 0
	for (const value of bytes) hash = (hash * 31 + value) >>> 0
	return `"${hash.toString(16)}"`
}

function createMemoryS3() {
	const objects = new Map<string, { bytes: Uint8Array; etag: string }>()
	const client: DrBackupS3Client = {
		async head(key) {
			const entry = objects.get(key)
			return entry
				? { exists: true, status: 200, etag: entry.etag }
				: { exists: false, status: 404, etag: null }
		},
		async getText(key) {
			const entry = objects.get(key)
			if (!entry) return null
			return {
				text: new TextDecoder().decode(entry.bytes),
				etag: entry.etag,
			}
		},
		async getBytes(key) {
			return objects.get(key)?.bytes ?? null
		},
		async put(key, body, options: DrBackupS3PutOptions = {}) {
			const existing = objects.get(key)
			if (options.ifNoneMatch === '*' && existing) {
				throw new DrBackupPreconditionFailedError(key)
			}
			if (options.ifMatch) {
				if (!existing || existing.etag !== options.ifMatch) {
					throw new DrBackupPreconditionFailedError(key)
				}
			}
			const bytes =
				typeof body === 'string' ? new TextEncoder().encode(body) : body
			const etag = etagFor(bytes)
			objects.set(key, { bytes, etag })
			return { etag }
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
	const dumpEntry = JSON.parse(dump!.text.trim()) as StorageDumpEntry
	expect(dumpEntry).toEqual({
		key: 'alpha',
		valueJson: JSON.stringify({ n: 1 }),
	})
	const dumpDigest = await sha256Hex(dump!.text)
	expect(dumpDigest).toMatch(/^[0-9a-f]{64}$/)

	const emailIndex = await client.getText(stagingR2IndexKey(day, 'email-blobs'))
	expect(emailIndex?.text).toContain('raw/one')
	const blobDigest = await sha256Hex(blobBytes)
	expect(objects.has(backupBlobKey(blobDigest))).toBe(true)

	const summary = JSON.parse(
		(await client.getText(stagingSummaryKey(day)))!.text,
	)
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
	client.put = async (key, body, options) => {
		const result = await originalPut(key, body, options)
		// After the first storage dump lands, exhaust the tick budget so the
		// second storage identity is deferred to the next cron tick.
		if (key.includes('/storage/') && key.endsWith('.ndjson')) {
			nowMs += 50_000
		}
		return result
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

test('exporter skips oversized storage dumps with a summary warning', async () => {
	storageMocks.exportStorage.mockReset()
	const hugeValue = 'x'.repeat(drExportMaxStorageDumpBufferBytes + 1)
	storageMocks.exportStorage.mockImplementation(
		async (input: { startAfter?: string | null }) => {
			if (input.startAfter) {
				return {
					entries: [],
					truncated: false,
					nextStartAfter: null,
					pageSize: 250,
					estimatedBytes: 0,
				}
			}
			return {
				entries: [{ key: 'huge', value: hugeValue }],
				truncated: false,
				nextStartAfter: null,
				pageSize: 250,
				estimatedBytes: hugeValue.length,
			}
		},
	)
	const { client } = createMemoryS3()
	const identity = encodeStorageIdentity('user-a', 'job:huge')
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_DB: createDb({
			jobs: [{ userId: 'user-a', storageId: 'job:huge' }],
		}),
		EMAIL_BLOBS: createR2({}),
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
	expect(result.summaryWritten).toBe(true)
	const summary = JSON.parse(
		(await client.getText(stagingSummaryKey('2026-07-23')))!.text,
	)
	expect(summary.warnings).toContain(`storage dump too large: ${identity}`)
	expect(
		await client.getText(stagingStorageDumpKey('2026-07-23', identity)),
	).toBeNull()
})

test('exporter aborts quietly when progress If-Match precondition fails', async () => {
	storageMocks.exportStorage.mockReset()
	storageMocks.exportStorage.mockResolvedValue({
		entries: [{ key: 'k', value: 1 }],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 1,
	})
	const { client } = createMemoryS3()
	const originalPut = client.put.bind(client)
	let progressPuts = 0
	client.put = async (key, body, options) => {
		if (key.includes('exporter/progress.json')) {
			progressPuts += 1
			if (progressPuts === 1) {
				return originalPut(key, body, options)
			}
			throw new DrBackupPreconditionFailedError(key)
		}
		return originalPut(key, body, options)
	}
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_DB: createDb({
			jobs: [{ userId: 'user-a', storageId: 'job:1' }],
		}),
		EMAIL_BLOBS: createR2({}),
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
	expect(result.skipped).toBe(true)
	expect(result.reason).toBe('progress-precondition-failed')
})

test('R2 full-buffer ceiling is 25 MiB', () => {
	expect(drExportMaxObjectBytes).toBe(25 * 1024 * 1024)
})

test('R2 export does not duplicate index lines across budget interruptions', async () => {
	storageMocks.exportStorage.mockReset()
	storageMocks.exportStorage.mockResolvedValue({
		entries: [],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 0,
	})
	const pageOne = {
		a: new TextEncoder().encode('a'),
		b: new TextEncoder().encode('b'),
	}
	const pageTwo = {
		c: new TextEncoder().encode('c'),
	}
	const all = { ...pageOne, ...pageTwo }
	let listCalls = 0
	const pagingR2 = {
		async list(input?: { cursor?: string }) {
			listCalls += 1
			if (!input?.cursor) {
				return {
					objects: Object.entries(pageOne).map(([key, value]) => ({
						key,
						size: value.byteLength,
						uploaded: new Date(),
						etag: 'etag',
						httpEtag: 'etag',
						checksums: {},
						version: 'v1',
					})),
					truncated: true,
					cursor: 'page-2',
				}
			}
			return {
				objects: Object.entries(pageTwo).map(([key, value]) => ({
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
			const value = all[key as keyof typeof all]
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

	const { client } = createMemoryS3()
	let nowMs = 1_000_000
	const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
	const originalPut = client.put.bind(client)
	client.put = async (key, body, options) => {
		const result = await originalPut(key, body, options)
		// After the first R2 list page is persisted (cursor advanced), exhaust
		// the budget so the next tick resumes from page-2.
		if (
			key.includes('exporter/progress.json') &&
			typeof body === 'string' &&
			body.includes('"r2ListCursor":"page-2"')
		) {
			nowMs += 50_000
		}
		return result
	}

	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_DB: createDb({}),
		EMAIL_BLOBS: pagingR2,
		COMMUNITY_ASSETS: createR2({}),
		BUNDLE_ARTIFACTS_KV: { get: async () => null },
		STORAGE_RUNNER: {},
	} as unknown as Env

	try {
		const tick1 = await runDrExportTick({
			env,
			now: new Date('2026-07-23T01:00:00.000Z'),
			timeBudgetMs: 20_000,
			s3: client,
		})
		expect(tick1.timeBudgetExhausted).toBe(true)
		expect(tick1.summaryWritten).toBe(false)

		nowMs = 1_000_000
		const tick2 = await runDrExportTick({
			env,
			now: new Date('2026-07-23T01:00:00.000Z'),
			timeBudgetMs: 60_000,
			s3: client,
		})
		expect(tick2.summaryWritten).toBe(true)
		expect(listCalls).toBeGreaterThanOrEqual(2)

		const index = (await client.getText(
			stagingR2IndexKey('2026-07-23', 'email-blobs'),
		))!.text
		const keys = index
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { key: string }).key)
		expect(keys).toEqual(['a', 'b', 'c'])
		expect(new Set(keys).size).toBe(keys.length)
	} finally {
		dateNow.mockRestore()
	}
})

test('initial progress shape includes phase, revision, and cursors', () => {
	const progress = __testOnlyCreateInitialProgress(
		'2026-07-23',
		new Date('2026-07-23T01:00:00.000Z'),
	)
	expect(progress.phase).toBe('storage')
	expect(progress.revision).toBe(0)
	expect(progress.storageIndex).toBe(0)
	expect(progress.storagePageStartAfter).toBeNull()
	expect(progress.r2LabelIndex).toBe(0)
	expect(progress.artifactsIndex).toBe(0)
})
