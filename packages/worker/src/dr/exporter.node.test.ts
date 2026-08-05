import { expect, test, vi } from 'vitest'
import {
	backupStagingLegacySchemaVersion,
	backupStagingSchemaVersion,
	backupBlobKey,
	sealedFullManifestKey,
	sealedFullPrefix,
	stagingArtifactsIndexKey,
	stagingMailboxDumpKey,
	stagingMailboxIndexKey,
	stagingR2IndexKey,
	stagingRunLogDumpKey,
	stagingRunLogIndexKey,
	stagingStorageDumpKey,
	stagingStorageIndexKey,
	stagingSummaryKey,
	type StorageDumpEntry,
} from '@kody-internal/shared/backup-staging.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import {
	drExportMaxStorageDumpBufferBytes,
	__testOnlyCreateInitialProgress,
	__testOnlyParseProgress,
	listPlatformStorageInventory,
	runDrExportTick,
	runDrExportWatchdogTick,
	shouldRunDrExportCron,
	shouldRunDrExportWatchdogCron,
} from '#worker/dr/exporter.ts'
import { listPlatformOwnerInventory } from '#worker/dr/exporter-inventory.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'
import {
	DrBackupPreconditionFailedError,
	type DrBackupS3Client,
	type DrBackupS3PutOptions,
} from '#worker/dr/backup-s3.ts'

const storageMocks = vi.hoisted(() => ({
	exportStorage: vi.fn(),
}))

const mailboxMocks = vi.hoisted(() => ({
	exportMailbox: vi.fn(),
}))

const runLogMocks = vi.hoisted(() => ({
	exportRuns: vi.fn(),
}))

const storageBucketMocks = vi.hoisted(() => ({
	listPlatformStorageBuckets: vi.fn(
		async () => [] as Array<{ userId: string; storageId: string }>,
	),
}))

vi.mock('#worker/storage-runner.ts', () => ({
	storageRunnerRpc: () => ({
		exportStorage: storageMocks.exportStorage,
	}),
}))

vi.mock('#worker/email/mailbox-client.ts', () => ({
	mailboxRpc: () => ({
		exportMailbox: mailboxMocks.exportMailbox,
	}),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	runLogRpc: () => ({
		exportRuns: runLogMocks.exportRuns,
	}),
}))

vi.mock('#worker/storage-buckets/service.ts', () => ({
	listPlatformStorageBuckets: storageBucketMocks.listPlatformStorageBuckets,
	listUserStorageBucketIds: vi.fn(async () => []),
	registerStorageBucket: vi.fn(),
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
	users?: Array<{ ownerId: string }>
	jobs?: Array<{ userId: string; storageId: string }>
	archived?: Array<{ userId: string; storageId: string }>
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
					if (sql.includes('FROM users')) {
						return { results: results.users ?? [] }
					}
					if (sql.includes('FROM jobs')) {
						return { results: results.jobs ?? [] }
					}
					if (sql.includes('FROM archived_job_artifacts')) {
						return { results: results.archived ?? [] }
					}
					if (sql.includes('FROM package_service_states')) {
						return { results: results.services ?? [] }
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

test('exporter progresses phases with mocked bindings and S3, writing summary last', async () => {
	expect(shouldRunDrExportCron(new Date('2026-07-23T00:25:00.000Z'))).toBe(
		false,
	)
	expect(shouldRunDrExportCron(new Date('2026-07-23T00:30:00.000Z'))).toBe(true)
	expect(shouldRunDrExportCron(new Date('2026-07-23T01:45:00.000Z'))).toBe(true)
	expect(shouldRunDrExportCron(new Date('2026-07-23T06:10:00.000Z'))).toBe(true)
	expect(shouldRunDrExportCron(new Date('2026-07-23T06:15:00.000Z'))).toBe(
		false,
	)
	expect(
		shouldRunDrExportWatchdogCron(new Date('2026-07-23T06:10:00.000Z')),
	).toBe(false)
	expect(
		shouldRunDrExportWatchdogCron(new Date('2026-07-23T06:15:00.000Z')),
	).toBe(true)
	expect(
		shouldRunDrExportWatchdogCron(new Date('2026-07-23T06:20:00.000Z')),
	).toBe(false)
	expect(
		await runDrExportTick({
			env: { DR_EXPORT_ENABLED: 'false' } as unknown as Env,
			now: new Date('2026-07-23T01:00:00.000Z'),
		}),
	).toMatchObject({ skipped: true, reason: 'not-configured' })
	expect(
		await runDrExportTick({
			env: { DR_EXPORT_ENABLED: 'true' } as unknown as Env,
			now: new Date('2026-07-23T00:25:00.000Z'),
		}),
	).toMatchObject({ skipped: true, reason: 'outside-nightly-window' })

	storageMocks.exportStorage.mockReset()
	storageMocks.exportStorage.mockResolvedValue({
		entries: [{ key: 'alpha', value: { n: 1 } }],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 10,
	})
	mailboxMocks.exportMailbox.mockReset()
	mailboxMocks.exportMailbox.mockResolvedValue({
		rows: [{ kind: 'thread', row: { id: 'thread-1' } }],
		truncated: false,
		nextStartAfter: null,
	})
	runLogMocks.exportRuns.mockReset()
	runLogMocks.exportRuns.mockResolvedValue({
		runs: [{ id: 'excluded-run' }],
		logs: [{ id: 'excluded-log' }],
		packageInvocations: [{ id: 'excluded-invocation' }],
		workflowProjections: [{ id: 'excluded-projection' }],
		jobRunObservability: [{ jobId: 'job-1', runCount: 2 }],
		packageRunSuccesses: [{ packageId: 'pkg-1', successCount: 2 }],
		activationMilestones: [
			{
				milestone: 'package_activated',
				reachedAt: '2026-07-23T00:00:00.000Z',
				packageId: 'pkg-1',
			},
		],
		truncated: false,
		nextStartAfter: null,
	})
	const { client, objects } = createMemoryS3()
	const blobBytes = new TextEncoder().encode('email-bytes')
	const blobDigest = await sha256Hex(blobBytes)
	const blobKey = backupBlobKey(blobDigest)
	await client.put(blobKey, blobBytes)
	const headSpy = vi.spyOn(client, 'head')
	const putSpy = vi.spyOn(client, 'put')
	const kvSnapshot = JSON.stringify({ version: 1, files: { 'a.ts': 'x' } })
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_COMMIT_SHA: 'abcdef1',
		APP_DB: createDb({
			users: [{ ownerId: 'user-a' }],
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
	expect(first.mailboxDumpsCompleted).toBe(1)
	expect(first.runLogDumpsCompleted).toBe(1)
	expect(first.blobsReused).toBeGreaterThanOrEqual(1)

	const day = '2026-07-23'
	const mailboxDump = (await client.getText(
		stagingMailboxDumpKey(day, 'user-a'),
	))!.text
	expect(
		mailboxDump
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line)),
	).toEqual([{ kind: 'thread', row: { id: 'thread-1' } }])
	const mailboxIndex = JSON.parse(
		(await client.getText(stagingMailboxIndexKey(day)))!.text,
	) as {
		entries: Array<{
			ownerId: string
			objectKey: string
			entryCount: number
			bytes: number
			sha256: string
		}>
	}
	expect(mailboxIndex.entries).toEqual([
		{
			ownerId: 'user-a',
			objectKey: stagingMailboxDumpKey(day, 'user-a'),
			entryCount: 1,
			bytes: new TextEncoder().encode(mailboxDump).byteLength,
			sha256: await sha256Hex(mailboxDump),
		},
	])

	expect(runLogMocks.exportRuns).toHaveBeenCalledWith({
		pageSize: 250,
		startAfter: 'job-run-observability:',
	})
	const runLogDump = (await client.getText(
		stagingRunLogDumpKey(day, 'user-a'),
	))!.text
	const runLogRows = runLogDump
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { kind: string; row: unknown })
	expect(runLogRows.map((row) => row.kind)).toEqual([
		'jobRunObservability',
		'packageRunSuccess',
		'activationMilestone',
	])
	expect(runLogDump).not.toContain('excluded-run')
	expect(runLogDump).not.toContain('excluded-log')
	expect(runLogDump).not.toContain('excluded-invocation')
	expect(runLogDump).not.toContain('excluded-projection')
	const runLogIndex = JSON.parse(
		(await client.getText(stagingRunLogIndexKey(day)))!.text,
	) as { entries: Array<Record<string, unknown>> }
	expect(runLogIndex.entries).toEqual([
		{
			ownerId: 'user-a',
			objectKey: stagingRunLogDumpKey(day, 'user-a'),
			entryCount: 3,
			bytes: new TextEncoder().encode(runLogDump).byteLength,
			sha256: await sha256Hex(runLogDump),
		},
	])

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
	expect(objects.has(blobKey)).toBe(true)
	expect(headSpy).toHaveBeenCalledWith(blobKey)
	expect(putSpy.mock.calls.filter(([key]) => key === blobKey)).toHaveLength(0)

	const summary = JSON.parse(
		(await client.getText(stagingSummaryKey(day)))!.text,
	)
	expect(summary.day).toBe(day)
	expect(summary.mailboxIndex).toEqual({
		objectKey: stagingMailboxIndexKey(day),
		bytes: new TextEncoder().encode(JSON.stringify(mailboxIndex)).byteLength,
		sha256: await sha256Hex(JSON.stringify(mailboxIndex)),
	})
	expect(summary.runLogIndex).toEqual({
		objectKey: stagingRunLogIndexKey(day),
		bytes: new TextEncoder().encode(JSON.stringify(runLogIndex)).byteLength,
		sha256: await sha256Hex(JSON.stringify(runLogIndex)),
	})
	expect(summary.storageIndex.sha256).toMatch(/^[0-9a-f]{64}$/)
	expect(summary.blobsWritten).toBeGreaterThanOrEqual(1)
	expect(summary.blobsReused).toBeGreaterThanOrEqual(1)
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
	const { client, objects } = createMemoryS3()
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
		const progressAfterFirstTick = JSON.parse(
			(await client.getText('staging/2026-07-23/exporter/progress.json'))!.text,
		) as Record<string, unknown>
		expect(progressAfterFirstTick).not.toHaveProperty('storageEntries')
		expect(progressAfterFirstTick).not.toHaveProperty('artifactEntries')
		expect(progressAfterFirstTick).not.toHaveProperty('storagePartialNdjson')
		expect(progressAfterFirstTick).not.toHaveProperty('r2PartialNdjson')
		expect(progressAfterFirstTick.storagePendingEntries).toHaveLength(1)

		nowMs = 1_000_000
		const tick2 = await runDrExportTick({
			env,
			now,
			timeBudgetMs: 60_000,
			s3: client,
		})
		expect(tick2.summaryWritten).toBe(true)
		expect(storageMocks.exportStorage.mock.calls.length).toBe(2)
		expect(
			[...objects.keys()].some((key) =>
				key.startsWith('staging/2026-07-23/exporter/chunks/storage-index/'),
			),
		).toBe(true)
	} finally {
		dateNow.mockRestore()
	}
})

test('mailbox paging resumes without duplicate or missing rows', async () => {
	mailboxMocks.exportMailbox.mockReset()
	mailboxMocks.exportMailbox
		.mockResolvedValueOnce({
			rows: [
				{ kind: 'message', row: { id: 'message-a' } },
				{ kind: 'message', row: { id: 'message-b' } },
			],
			truncated: true,
			nextStartAfter: 'message:message-b',
		})
		.mockResolvedValueOnce({
			rows: [{ kind: 'message', row: { id: 'message-c' } }],
			truncated: false,
			nextStartAfter: null,
		})
	runLogMocks.exportRuns.mockResolvedValue({
		runs: [],
		logs: [],
		packageInvocations: [],
		workflowProjections: [],
		jobRunObservability: [],
		packageRunSuccesses: [],
		activationMilestones: [],
		truncated: false,
		nextStartAfter: null,
	})
	storageMocks.exportStorage.mockResolvedValue({
		entries: [],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 0,
	})
	const { client } = createMemoryS3()
	let nowMs = 1_000_000
	const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
	const originalPut = client.put.bind(client)
	let exhausted = false
	client.put = async (key, body, options) => {
		const result = await originalPut(key, body, options)
		if (
			!exhausted &&
			key.endsWith('/exporter/progress.json') &&
			typeof body === 'string' &&
			body.includes('"pageStartAfter":"message:message-b"')
		) {
			exhausted = true
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
		APP_DB: createDb({ users: [{ ownerId: 'user/with space' }] }),
		EMAIL_BLOBS: createR2({}),
		COMMUNITY_ASSETS: createR2({}),
		BUNDLE_ARTIFACTS_KV: { get: async () => null },
		MAILBOX: {},
		RUN_LOG: {},
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
		expect(tick1.mailboxDumpsCompleted).toBe(0)

		nowMs = 1_000_000
		const tick2 = await runDrExportTick({
			env,
			now: new Date('2026-07-23T01:05:00.000Z'),
			timeBudgetMs: 60_000,
			s3: client,
		})
		expect(tick2.summaryWritten).toBe(true)
		expect(mailboxMocks.exportMailbox.mock.calls).toEqual([
			[{ pageSize: 250, startAfter: null }],
			[{ pageSize: 250, startAfter: 'message:message-b' }],
		])
		const dump = (await client.getText(
			stagingMailboxDumpKey('2026-07-23', 'user/with space'),
		))!.text
		const ids = dump
			.trim()
			.split('\n')
			.map((line) => (JSON.parse(line) as { row: { id: string } }).row.id)
		expect(ids).toEqual(['message-a', 'message-b', 'message-c'])
		expect(new Set(ids).size).toBe(ids.length)
	} finally {
		dateNow.mockRestore()
	}
})

test('inventory drift between ticks neither duplicates nor skips storage dumps', async () => {
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
		// Exhaust the budget after the first dump so the run resumes on the
		// next tick against a drifted inventory.
		if (key.includes('/storage/') && key.endsWith('.ndjson')) {
			nowMs += 50_000
		}
		return result
	}
	// Sorted inventory starts as [job:2, job:3]; tick 1 completes job:2.
	const jobs = [
		{ userId: 'user-a', storageId: 'job:2' },
		{ userId: 'user-a', storageId: 'job:3' },
	]
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_DB: createDb({ jobs }),
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
		expect(tick1.storageDumpsCompleted).toBe(1)

		// A job registers a new bucket mid-window that sorts BEFORE the
		// completed identity. A positional cursor would re-dump job:2
		// (duplicate index entry) and never dump job:1.
		jobs.unshift({ userId: 'user-a', storageId: 'job:1' })

		nowMs = 1_000_000
		const tick2 = await runDrExportTick({
			env,
			now,
			timeBudgetMs: 200_000,
			s3: client,
		})
		expect(tick2.summaryWritten).toBe(true)

		const summary = JSON.parse(
			(await client.getText(stagingSummaryKey('2026-07-23')))!.text,
		)
		const storageIndex = JSON.parse(
			(await client.getText(summary.storageIndex.objectKey))!.text,
		) as { entries: Array<{ storageId: string }> }
		const identities = storageIndex.entries.map((entry) => entry.storageId)
		expect(identities.sort()).toEqual([
			encodeStorageIdentity('user-a', 'job:1'),
			encodeStorageIdentity('user-a', 'job:2'),
			encodeStorageIdentity('user-a', 'job:3'),
		])
		expect(new Set(identities).size).toBe(identities.length)
		expect(storageMocks.exportStorage.mock.calls.length).toBe(3)
	} finally {
		dateNow.mockRestore()
	}
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
	let storedValue = 1
	storageMocks.exportStorage.mockImplementation(async () => ({
		entries: [{ key: 'k', value: storedValue }],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 1,
	}))
	const { client } = createMemoryS3()
	const originalPut = client.put.bind(client)
	let storageDumpWritten = false
	let failedProgressAfterStorageDump = false
	client.put = async (key, body, options) => {
		if (key.includes('/storage/') && key.endsWith('.ndjson')) {
			storageDumpWritten = true
		}
		if (
			key.includes('exporter/progress.json') &&
			storageDumpWritten &&
			!failedProgressAfterStorageDump
		) {
			failedProgressAfterStorageDump = true
			throw new DrBackupPreconditionFailedError(key)
		}
		return originalPut(key, body, options)
	}
	let nowMs = 1_000_000
	const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
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

	try {
		const result = await runDrExportTick({
			env,
			now: new Date('2026-07-23T01:00:00.000Z'),
			timeBudgetMs: 60_000,
			s3: client,
		})
		expect(result.skipped).toBe(true)
		expect(result.reason).toBe('progress-precondition-failed')

		// The failed tick wrote a complete immutable dump before losing
		// progress ownership. Once its lease expires, changed source bytes can
		// produce a new orphaned chunk while resume adopts the first complete
		// dump and finishes rather than conflicting forever.
		storedValue = 2
		nowMs += 3 * 60_000
		const resumed = await runDrExportTick({
			env,
			now: new Date('2026-07-23T01:05:00.000Z'),
			timeBudgetMs: 60_000,
			s3: client,
		})
		expect(resumed.summaryWritten).toBe(true)
		const identity = encodeStorageIdentity('user-a', 'job:1')
		const dump = await client.getText(
			stagingStorageDumpKey('2026-07-23', identity),
		)
		expect(JSON.parse(dump!.text.trim())).toMatchObject({
			valueJson: JSON.stringify(1),
		})
	} finally {
		dateNow.mockRestore()
	}
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
	let exhaustedAfterFirstPage = false
	client.put = async (key, body, options) => {
		const result = await originalPut(key, body, options)
		// After the first R2 list page is persisted (cursor advanced), exhaust
		// the budget so the next tick resumes from page-2.
		if (
			key.includes('exporter/progress.json') &&
			typeof body === 'string' &&
			body.includes('"r2ListCursor":"page-2"') &&
			!exhaustedAfterFirstPage
		) {
			exhaustedAfterFirstPage = true
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

test('R2 export reuses unchanged objects from the latest sealed index', async () => {
	storageMocks.exportStorage.mockReset()
	storageMocks.exportStorage.mockResolvedValue({
		entries: [],
		truncated: false,
		nextStartAfter: null,
		pageSize: 250,
		estimatedBytes: 0,
	})
	const unchangedBytes = new TextEncoder().encode('unchanged')
	const changedBytes = new TextEncoder().encode('changed-now')
	const unchangedDigest = await sha256Hex(unchangedBytes)
	const oldChangedDigest = await sha256Hex('changed-before')
	const uploaded = new Date('2026-07-20T12:00:00.000Z')
	const previousIndexBody = [
		{
			key: 'unchanged',
			size: unchangedBytes.byteLength,
			sha256: unchangedDigest,
			etag: 'etag-unchanged',
			uploaded: uploaded.toISOString(),
		},
		{
			key: 'changed',
			size: changedBytes.byteLength,
			sha256: oldChangedDigest,
			etag: 'etag-before',
			uploaded: uploaded.toISOString(),
		},
	]
		.map((entry) => `${JSON.stringify(entry)}\n`)
		.join('')
	const previousIndexKey = `${sealedFullPrefix('2026-07-22')}r2-index/email-blobs.ndjson`
	const { client } = createMemoryS3()
	await client.put(previousIndexKey, previousIndexBody)
	await client.put(backupBlobKey(unchangedDigest), unchangedBytes)
	await client.put(
		sealedFullManifestKey('2026-07-22'),
		JSON.stringify({
			schemaVersion: 1,
			payload: {
				schemaVersion: 1,
				day: '2026-07-22',
				d1ManifestKey: 'daily/d1/2026-07-22/manifest.json',
				d1ManifestSha256: 'a'.repeat(64),
				storageIndex: {
					objectKey: `${sealedFullPrefix('2026-07-22')}storage-index.json`,
					bytes: 0,
					sha256: 'b'.repeat(64),
				},
				r2Indexes: {
					'email-blobs': {
						objectKey: previousIndexKey,
						bytes: new TextEncoder().encode(previousIndexBody).byteLength,
						sha256: await sha256Hex(previousIndexBody),
					},
				},
				artifactsIndex: {
					objectKey: `${sealedFullPrefix('2026-07-22')}artifacts-index.json`,
					bytes: 0,
					sha256: 'c'.repeat(64),
				},
				sealedAt: '2026-07-22T06:30:00.000Z',
				buildCommit: 'abcdef1',
				signing: { algorithm: 'Ed25519', keyId: 'test-key' },
			},
			signature: {
				algorithm: 'Ed25519',
				keyId: 'test-key',
				value: 'test-signature',
			},
		}),
	)
	const get = vi.fn(async (key: string) => {
		const bytes =
			key === 'unchanged'
				? unchangedBytes
				: key === 'changed'
					? changedBytes
					: null
		if (!bytes) return null
		return {
			arrayBuffer: async () =>
				bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				),
		}
	})
	const emailBucket = {
		async list() {
			return {
				objects: [
					{
						key: 'unchanged',
						size: unchangedBytes.byteLength,
						uploaded,
						etag: 'etag-unchanged',
					},
					{
						key: 'changed',
						size: changedBytes.byteLength,
						uploaded,
						etag: 'etag-now',
					},
				],
				truncated: false,
				cursor: '',
			}
		},
		get,
	} as unknown as R2Bucket
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_DB: createDb({}),
		EMAIL_BLOBS: emailBucket,
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
	expect(get).toHaveBeenCalledTimes(1)
	expect(get).toHaveBeenCalledWith('changed')
	const currentIndex = (await client.getText(
		stagingR2IndexKey('2026-07-23', 'email-blobs'),
	))!.text
	const entries = currentIndex
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { key: string; sha256: string })
	expect(entries).toEqual([
		expect.objectContaining({ key: 'unchanged', sha256: unchangedDigest }),
		expect.objectContaining({
			key: 'changed',
			sha256: await sha256Hex(changedBytes),
		}),
	])
})

test('DR inventory includes registry storage and excludes deleting owners', async () => {
	storageBucketMocks.listPlatformStorageBuckets.mockResolvedValueOnce([
		{ userId: 'user-a', storageId: 'exec:adhoc-only' },
	])
	const inventory = await listPlatformStorageInventory(
		createDb({
			services: [
				{
					userId: 'user-a',
					packageId: 'pkg-1',
					serviceName: 'worker',
				},
			],
		}),
	)
	expect(inventory.map((entry) => entry.storageId).sort()).toEqual([
		'exec:adhoc-only',
		'service:pkg-1:worker',
	])
	expect(inventory.every((entry) => entry.userId === 'user-a')).toBe(true)

	const prepare = vi.fn((sql: string) => ({
		all: async () => ({
			results: [{ ownerId: 'active-owner' }],
		}),
		sql,
	}))
	const owners = await listPlatformOwnerInventory({
		prepare,
	} as unknown as D1Database)
	expect(owners).toEqual(['active-owner'])
	expect(prepare).toHaveBeenCalledWith(
		expect.stringMatching(/FROM users\s+WHERE deleting_at IS NULL/),
	)
})

test('progress parsing rejects missing or malformed owner lanes', () => {
	const progress = __testOnlyCreateInitialProgress(
		'2026-07-23',
		new Date('2026-07-23T00:30:00.000Z'),
	)
	expect(__testOnlyParseProgress(progress)).toMatchObject({
		phase: 'mailbox',
	})
	expect(
		__testOnlyParseProgress({ ...progress, mailbox: undefined }),
	).toBeNull()
	expect(
		__testOnlyParseProgress({
			...progress,
			runLog: { ...progress.runLog, dumpChunkCount: -1 },
		}),
	).toBeNull()
})

test('a schema-v1 completion marker is conditionally upgraded after owner lanes finish', async () => {
	storageBucketMocks.listPlatformStorageBuckets.mockResolvedValue([])
	const { client } = createMemoryS3()
	const day = '2026-07-23'
	const file = (objectKey: string, sha: string) => ({
		objectKey,
		bytes: 0,
		sha256: sha.repeat(64),
	})
	await client.put(
		stagingSummaryKey(day),
		JSON.stringify({
			schemaVersion: backupStagingLegacySchemaVersion,
			day,
			startedAt: `${day}T00:30:00.000Z`,
			completedAt: `${day}T00:35:00.000Z`,
			buildCommit: 'legacy-build',
			storageIndex: file(stagingStorageIndexKey(day), 'a'),
			r2Indexes: {},
			artifactsIndex: file(stagingArtifactsIndexKey(day), 'b'),
			blobsWritten: 0,
			blobsReused: 0,
			warnings: [],
		}),
	)
	const legacy = await client.getText(stagingSummaryKey(day))
	const putSpy = vi.spyOn(client, 'put')
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		APP_DB: createDb({}),
		EMAIL_BLOBS: createR2({}),
		COMMUNITY_ASSETS: createR2({}),
		BUNDLE_ARTIFACTS_KV: { get: async () => null },
		STORAGE_RUNNER: {},
	} as unknown as Env

	const result = await runDrExportTick({
		env,
		now: new Date(`${day}T01:00:00.000Z`),
		timeBudgetMs: 60_000,
		s3: client,
	})
	expect(result.summaryWritten).toBe(true)
	const upgraded = JSON.parse(
		(await client.getText(stagingSummaryKey(day)))!.text,
	) as Record<string, unknown>
	expect(upgraded.schemaVersion).toBe(backupStagingSchemaVersion)
	expect(upgraded).toHaveProperty('mailboxIndex')
	expect(upgraded).toHaveProperty('runLogIndex')
	expect(putSpy).toHaveBeenCalledWith(
		stagingSummaryKey(day),
		expect.any(String),
		expect.objectContaining({ ifMatch: legacy!.etag }),
	)
})

test('watchdog passes on a written summary and fails loudly on an incomplete night', async () => {
	const env = {
		DR_EXPORT_ENABLED: 'true',
		DR_BACKUP_ACCOUNT_ID: 'acct',
		DR_BACKUP_BUCKET_NAME: 'bucket',
		DR_BACKUP_ACCESS_KEY_ID: 'key',
		DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
	} as unknown as Env
	const now = new Date('2026-07-23T06:15:00.000Z')

	expect(
		await runDrExportWatchdogTick({
			env: { DR_EXPORT_ENABLED: 'false' } as unknown as Env,
			now,
		}),
	).toMatchObject({ skipped: true, reason: 'not-configured' })

	const { client } = createMemoryS3()
	await client.put(
		stagingSummaryKey('2026-07-23'),
		new TextEncoder().encode('{}'),
	)
	expect(await runDrExportWatchdogTick({ env, now, s3: client })).toMatchObject(
		{ day: '2026-07-23', summaryPresent: true },
	)

	const incomplete = createMemoryS3()
	await incomplete.client.put(
		'staging/2026-07-23/exporter/progress.json',
		new TextEncoder().encode(
			JSON.stringify({
				schemaVersion: 3,
				day: '2026-07-23',
				startedAt: '2026-07-23T00:30:00.000Z',
				phase: 'artifacts',
				revision: 42,
				leaseId: null,
				leaseExpiresAt: null,
				mailbox: {
					ownerIndex: 10,
					pageStartAfter: null,
					partialOwnerId: null,
					dumpChunkCount: 0,
					dumpChunkHead: null,
					partialEntryCount: 0,
					partialBytes: 0,
					entryChunkCount: 0,
					entryChunkHead: null,
					pendingEntries: [],
				},
				runLog: {
					ownerIndex: 10,
					pageStartAfter: null,
					partialOwnerId: null,
					dumpChunkCount: 0,
					dumpChunkHead: null,
					partialEntryCount: 0,
					partialBytes: 0,
					entryChunkCount: 0,
					entryChunkHead: null,
					pendingEntries: [],
				},
				storageIndex: 10,
				storagePageStartAfter: null,
				storagePartialIdentity: null,
				storageDumpChunkCount: 0,
				storageDumpChunkHead: null,
				storagePartialEntryCount: 0,
				storagePartialBytes: 0,
				storageEntryChunkCount: 0,
				storageEntryChunkHead: null,
				storagePendingEntries: [],
				r2LabelIndex: 2,
				r2ListCursor: null,
				r2ChunkCount: 0,
				r2ChunkHead: null,
				r2FinalPageReady: false,
				r2Completed: {},
				previousSealedDayResolved: true,
				previousSealedDay: null,
				artifactsIndex: 7,
				artifactEntryChunkCount: 0,
				artifactEntryChunkHead: null,
				artifactPendingEntries: [],
				blobsWritten: 0,
				blobsReused: 0,
				warnings: [],
			}),
		),
	)
	await expect(
		runDrExportWatchdogTick({ env, now, s3: incomplete.client }),
	).rejects.toThrow(/summary missing for 2026-07-23.*phase=artifacts/)
})
