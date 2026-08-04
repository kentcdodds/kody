import assert from 'node:assert/strict'

import { afterEach, test, vi } from 'vitest'

import { runBackupRuntime } from './backup-runtime.ts'
import { DEFAULT_BACKUP_MAX_SOURCE_BYTES } from './d1-export-api.ts'
import { readManifest } from './immutable-storage.ts'
import {
	BackupError,
	backupPayload,
	objectKeyForBookmark,
	workflowInstanceId,
} from './backup-policy.ts'
import {
	CachedUploadStep,
	DATABASE_ID,
	MemoryBucket,
	PreStatsUploadStep,
	RetryAfterCommitStep,
	RetryUploadStep,
	badSqlStatsFixture,
	environment,
	exportEnvelope,
	identityEnvelope,
} from './backup-control-plane-test-support.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

test('source size gates block export for zero and oversize readings', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	let liveSize = 0
	let exportCalls = 0
	const options = {
		api: {
			fetcher: async (input: RequestInfo | URL) => {
				if (!String(input).endsWith('/export')) {
					return identityEnvelope(liveSize)
				}
				exportCalls += 1
				return exportEnvelope('complete')
			},
			sleep: async () => undefined,
		},
		downloadFetcher: async () =>
			new Response('valid', { headers: { 'content-length': '5' } }),
	}
	const event = {
		instanceId: workflowInstanceId(DATABASE_ID, payload.day),
		payload,
		timestamp: new Date('2026-07-22T02:15:01Z'),
	}

	await assert.rejects(
		runBackupRuntime(
			env,
			event,
			new CachedUploadStep(() => undefined),
			options,
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-zero' &&
			error.retryable,
	)
	assert.equal(exportCalls, 0)
	assert.equal(bucket.puts.length, 0)

	liveSize = 1_000
	const result = await runBackupRuntime(
		env,
		event,
		new CachedUploadStep(() => undefined),
		options,
	)
	assert.equal(result.payload.sql.bytes, 5)
	// One export start plus one upload-callback refresh; finalization never
	// polls D1 again.
	assert.equal(exportCalls, 2)

	consoleError.mockClear()
	const oversizeUrls: string[] = []
	await assert.rejects(
		runBackupRuntime(env, event, new RetryAfterCommitStep(), {
			api: {
				fetcher: async (input) => {
					oversizeUrls.push(String(input))
					return identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1)
				},
			},
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-limit-exceeded',
	)
	assert.equal(oversizeUrls.length, 1)
	assert.equal(
		oversizeUrls.some((url) => url.endsWith('/export')),
		false,
	)
	assert.equal(consoleError.mock.calls.length, 2)
})

test('legacy persisted scheduled payload without kind resumes as scheduled', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const current = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const legacyPayload = {
		scheduledAt: current.scheduledAt,
		day: current.day,
		objectPrefix: current.objectPrefix,
		manifestKey: current.manifestKey,
		retentionTier: current.retentionTier,
	}
	const result = await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, current.day),
			payload: legacyPayload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		new CachedUploadStep(() => undefined),
		{
			api: {
				fetcher: async (input) =>
					String(input).endsWith('/export')
						? exportEnvelope('complete')
						: identityEnvelope(1_000),
				sleep: async () => undefined,
			},
			downloadFetcher: async () =>
				new Response('valid', { headers: { 'content-length': '5' } }),
		},
	)

	assert.equal(result.payload.export.scheduledAt, legacyPayload.scheduledAt)
	assert.equal(result.payload.sql.bytes, 5)
	assert.notEqual(await bucket.get(current.manifestKey), null)
})

test('legacy scheduled compatibility rejects invalid dates, extra keys, and unusual objects', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const env = environment()
	const current = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const legacyPayload = {
		scheduledAt: current.scheduledAt,
		day: current.day,
		objectPrefix: current.objectPrefix,
		manifestKey: current.manifestKey,
		retentionTier: current.retentionTier,
	}
	const accessorPayload = { ...legacyPayload }
	Object.defineProperty(accessorPayload, 'scheduledAt', {
		enumerable: true,
		get: () => current.scheduledAt,
	})
	const symbolPayload = { ...legacyPayload }
	Object.defineProperty(symbolPayload, Symbol('extra'), {
		enumerable: true,
		value: 'extra',
	})
	for (const invalidPayload of [
		{ ...legacyPayload, scheduledAt: undefined },
		{ ...legacyPayload, scheduledAt: null },
		{ ...legacyPayload, scheduledAt: 'not-a-date' },
		{ ...legacyPayload, scheduledAt: '2026-07-22' },
		{ ...legacyPayload, scheduledAt: '2026-07-22T02:15:00Z' },
		{ ...legacyPayload, scheduledAt: '2026-02-30T02:15:00.000Z' },
		{ ...legacyPayload, extra: true },
		Object.assign(Object.create({ inherited: true }), legacyPayload),
		Object.assign(Object.create(null), legacyPayload),
		accessorPayload,
		symbolPayload,
	]) {
		await assert.rejects(
			runBackupRuntime(
				env,
				{
					instanceId: workflowInstanceId(DATABASE_ID, current.day),
					payload: invalidPayload,
					timestamp: new Date('2026-07-22T02:15:01Z'),
				},
				new CachedUploadStep(() => undefined),
			),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'invalid-workflow-payload',
		)
	}
	assert.equal(consoleError.mock.calls.length, 11)
})

test('scheduled discriminants require exact payload fields', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const env = environment()
	const current = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	for (const invalidPayload of [
		{ ...current, extra: true },
		Object.assign(Object.create({ inherited: true }), current),
	]) {
		await assert.rejects(
			runBackupRuntime(
				env,
				{
					instanceId: workflowInstanceId(DATABASE_ID, current.day),
					payload: invalidPayload,
					timestamp: new Date('2026-07-22T02:15:01Z'),
				},
				new CachedUploadStep(() => undefined),
			),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'invalid-workflow-payload',
		)
	}
	assert.equal(consoleError.mock.calls.length, 2)
})

test('workflow retry reuses an upload committed before step persistence and writes the absent manifest', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const step = new RetryAfterCommitStep()
	const apiCalls: string[] = []
	const downloadUrls: string[] = []
	let exportCalls = 0
	const result = await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		step,
		{
			api: {
				fetcher: async (input) => {
					const url = String(input)
					apiCalls.push(url)
					if (!url.endsWith('/export')) return identityEnvelope(1_000)
					exportCalls += 1
					return exportEnvelope(
						'complete',
						'bookmark-1',
						`https://download.example/url-${exportCalls}`,
					)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async (input) => {
				downloadUrls.push(String(input))
				return new Response('valid', {
					headers: { 'content-length': '5' },
				})
			},
		},
	)
	assert.deepEqual(step.uploadResults, [false, true])
	assert.deepEqual(downloadUrls, [
		'https://download.example/url-2',
		'https://download.example/url-3',
	])
	assert.equal(apiCalls.filter((url) => url.endsWith('/export')).length, 3)
	assert.equal(
		result.payload.sql.objectKey,
		objectKeyForBookmark(payload.objectPrefix, 'bookmark-1'),
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
	// Statement stats are persisted next to the SQL object.
	const statsObject = await (bucket as unknown as R2Bucket).get(
		`${result.payload.sql.objectKey}.stats.json`,
	)
	assert.notEqual(statsObject, null)
	const stats = JSON.parse(await statsObject!.text()) as {
		maxStatementBytes: number
		oversizedStatementCount: number
	}
	assert.equal(stats.oversizedStatementCount, 0)
	assert.ok(stats.maxStatementBytes > 0)
})

test('oversized SQL writes stats then fails retryably without a day manifest', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-31T02:15:00Z'))
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const sql = `INSERT INTO t VALUES ('${'x'.repeat(100_001)}');`

	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: workflowInstanceId(DATABASE_ID, payload.day),
				payload,
				timestamp: new Date('2026-07-31T02:15:01Z'),
			},
			new CachedUploadStep(() => undefined),
			{
				api: {
					fetcher: async (input) =>
						String(input).endsWith('/export')
							? exportEnvelope('complete')
							: identityEnvelope(1_000),
					sleep: async () => undefined,
				},
				downloadFetcher: async () =>
					new Response(sql, {
						headers: { 'content-length': String(sql.length) },
					}),
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'backup-unrestorable-statements' &&
			error.retryable,
	)

	const statsObject = await bucket.get(`${objectKey}.stats.json`)
	assert.notEqual(statsObject, null)
	const stats = (await statsObject!.json()) as {
		oversizedStatementCount: number
	}
	assert.equal(stats.oversizedStatementCount, 1)
	assert.equal(await bucket.head(payload.manifestKey), null)
	const events = consoleError.mock.calls.map(([record]) =>
		JSON.parse(String(record)),
	) as Array<{ event: string }>
	assert.ok(
		events.some(({ event }) => event === 'backup-unrestorable-statements'),
	)
	assert.ok(events.some(({ event }) => event === 'backup-failure'))
})

test('cached pre-stats uploads are allowed only for legacy backup days', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const consoleLog = vi.spyOn(console, 'log')
	consoleLog.mockImplementation(() => undefined)
	const options = {
		api: {
			fetcher: async (input: RequestInfo | URL) =>
				String(input).endsWith('/export')
					? exportEnvelope('complete')
					: identityEnvelope(1_000),
			sleep: async () => undefined,
		},
		downloadFetcher: async () =>
			new Response('valid', { headers: { 'content-length': '5' } }),
	}

	const legacyBucket = new MemoryBucket()
	const legacyEnv = environment(legacyBucket)
	const legacyPayload = backupPayload(
		legacyEnv,
		new Date('2026-07-27T02:15:00Z'),
	)
	await runBackupRuntime(
		legacyEnv,
		{
			instanceId: workflowInstanceId(DATABASE_ID, legacyPayload.day),
			payload: legacyPayload,
			timestamp: new Date('2026-07-27T02:15:01Z'),
		},
		new PreStatsUploadStep(),
		options,
	)
	assert.notEqual(await legacyBucket.head(legacyPayload.manifestKey), null)
	const legacyEvents = consoleLog.mock.calls.map(([record]) =>
		JSON.parse(String(record)),
	) as Array<{ event: string }>
	assert.ok(
		legacyEvents.some(({ event }) => event === 'backup-stats-legacy-missing'),
	)

	const requiredBucket = new MemoryBucket()
	const requiredEnv = environment(requiredBucket)
	const requiredPayload = backupPayload(
		requiredEnv,
		new Date('2026-07-28T02:15:00Z'),
	)
	await assert.rejects(
		runBackupRuntime(
			requiredEnv,
			{
				instanceId: workflowInstanceId(DATABASE_ID, requiredPayload.day),
				payload: requiredPayload,
				timestamp: new Date('2026-07-28T02:15:01Z'),
			},
			new PreStatsUploadStep(),
			options,
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'backup-sql-stats-missing' &&
			error.retryable,
	)
	assert.equal(await requiredBucket.head(requiredPayload.manifestKey), null)
})

test('conflicting immutable SQL stats prevent manifest publication', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-31T02:15:00Z'))
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')

	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: workflowInstanceId(DATABASE_ID, payload.day),
				payload,
				timestamp: new Date('2026-07-31T02:15:01Z'),
			},
			new CachedUploadStep(async () => {
				await bucket.put(
					`${objectKey}.stats.json`,
					JSON.stringify(badSqlStatsFixture(payload.day, objectKey)),
				)
			}),
			{
				api: {
					fetcher: async (input) =>
						String(input).endsWith('/export')
							? exportEnvelope('complete')
							: identityEnvelope(1_000),
					sleep: async () => undefined,
				},
				downloadFetcher: async () =>
					new Response('valid', { headers: { 'content-length': '5' } }),
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'backup-sql-stats-conflict',
	)
	assert.equal(await bucket.head(payload.manifestKey), null)
})

test('initial upload ignores a stale cached signed URL and refreshes it in the callback', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const exportBodies: unknown[] = []
	const downloadUrls: string[] = []
	let exportCalls = 0
	const result = await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		new CachedUploadStep(() => undefined),
		{
			api: {
				fetcher: async (input, init) => {
					if (!String(input).endsWith('/export')) return identityEnvelope(1_000)
					exportBodies.push(JSON.parse(String(init?.body)))
					exportCalls += 1
					return exportEnvelope(
						'complete',
						'bookmark-1',
						[
							'https://download.example/stale-initial',
							'https://download.example/fresh-upload',
							'https://download.example/fresh-finalization',
						][exportCalls - 1],
					)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async (input) => {
				const url = String(input)
				downloadUrls.push(url)
				if (url === 'https://download.example/stale-initial') {
					return new Response('', { status: 403 })
				}
				return new Response('valid', {
					headers: { 'content-length': '5' },
				})
			},
		},
	)
	assert.deepEqual(exportBodies, [
		{ output_format: 'polling' },
		{ output_format: 'polling', current_bookmark: 'bookmark-1' },
	])
	// The stale initial URL is never used and finalization performs no D1
	// download at all: it verifies the stored object against the durable
	// upload-step digest instead.
	assert.deepEqual(downloadUrls, ['https://download.example/fresh-upload'])
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('a replayed finalization tolerates the already-written manifest and stats', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const options = {
		api: {
			fetcher: async (input: RequestInfo | URL) =>
				String(input).endsWith('/export')
					? exportEnvelope('complete')
					: identityEnvelope(1_000),
			sleep: async () => undefined,
		},
		downloadFetcher: async () =>
			new Response('valid', { headers: { 'content-length': '5' } }),
	}
	const event = {
		instanceId: workflowInstanceId(DATABASE_ID, payload.day),
		payload,
		timestamp: new Date('2026-07-22T02:15:01Z'),
	}
	const step = new CachedUploadStep(() => undefined)
	const first = await runBackupRuntime(env, event, step, options)
	// Replaying the same instance returns every cached step result without
	// re-executing uploads or manifest writes.
	const replay = await runBackupRuntime(env, event, step, options)
	assert.deepEqual(replay, first)

	// A *new* execution over an already-manifested day fails closed on the
	// immutable manifest instead of silently replacing it.
	await new Promise((resolve) => setTimeout(resolve, 2))
	await assert.rejects(
		runBackupRuntime(env, event, new CachedUploadStep(() => undefined), {
			...options,
		}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'manifest-conflict',
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		first,
	)
})

test('zero-byte upload retries with a fresh URL before manifest success', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const step = new RetryUploadStep()
	let exportCalls = 0
	const downloadUrls: string[] = []
	const result = await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		step,
		{
			api: {
				fetcher: async (input) => {
					if (!String(input).endsWith('/export')) return identityEnvelope(1_000)
					exportCalls += 1
					return exportEnvelope(
						'complete',
						'bookmark-1',
						`https://download.example/export-${String(exportCalls)}`,
					)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async (input) => {
				const url = String(input)
				downloadUrls.push(url)
				if (url.endsWith('export-2')) {
					return new Response('', { headers: { 'content-length': '0' } })
				}
				return new Response('valid', {
					headers: { 'content-length': '5' },
				})
			},
		},
	)
	assert.deepEqual(step.uploadAttempts, [1, 2])
	assert.deepEqual(downloadUrls, [
		'https://download.example/export-2',
		'https://download.example/export-3',
	])
	assert.equal(result.payload.sql.bytes, 5)
	assert.equal(
		bucket.puts.filter(({ key }) => key === result.payload.sql.objectKey)
			.length,
		1,
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
})

test('tampered objects are rejected for retry and cached-upload paths without writing a manifest', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)

	// Corruption surfaces at the layer that next touches the object: an
	// upload-step retry compares the existing object against the signed
	// source download, while a cached upload result is re-verified against
	// the durable step digest at finalization (no D1 download).
	for (const { createStep, expectedCode, expectedDownloads } of [
		{
			createStep: (corrupt: () => void) => new RetryAfterCommitStep(corrupt),
			expectedCode: 'existing-object-source-mismatch',
			expectedDownloads: 2,
		},
		{
			createStep: (corrupt: () => void) => new CachedUploadStep(corrupt),
			expectedCode: 'stored-object-mismatch',
			expectedDownloads: 1,
		},
	]) {
		consoleError.mockClear()
		const bucket = new MemoryBucket()
		const env = environment(bucket)
		const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
		const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
		const step = createStep(() => {
			bucket.corrupt(objectKey, 'evil!')
		})
		let downloadCalls = 0
		await assert.rejects(
			runBackupRuntime(
				env,
				{
					instanceId: workflowInstanceId(DATABASE_ID, payload.day),
					payload,
					timestamp: new Date('2026-07-22T02:15:01Z'),
				},
				step,
				{
					api: {
						fetcher: async (input) =>
							String(input).endsWith('/export')
								? exportEnvelope('complete')
								: identityEnvelope(1_000),
						sleep: async () => undefined,
					},
					downloadFetcher: async () => {
						downloadCalls += 1
						return new Response('valid', {
							headers: { 'content-length': '5' },
						})
					},
				},
			),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === expectedCode &&
				error.retryable === false,
		)
		assert.equal(downloadCalls, expectedDownloads)
		assert.equal(
			await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
			null,
		)
		assert.equal(consoleError.mock.calls.length, 1)
	}
})

test('source verification and manifest commit share one Workflow step boundary', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	let finalizationObserved = false
	const step = new CachedUploadStep(
		() => undefined,
		async () => {
			finalizationObserved = true
			assert.notEqual(
				await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
				null,
			)
		},
	)
	await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		step,
		{
			api: {
				fetcher: async (input) =>
					String(input).endsWith('/export')
						? exportEnvelope('complete')
						: identityEnvelope(1_000),
				sleep: async () => undefined,
			},
			downloadFetcher: async () =>
				new Response('valid', {
					headers: { 'content-length': '5' },
				}),
		},
	)
	assert.equal(finalizationObserved, true)
})

test('manifest signing failure leaves committed SQL manifest-less and retry succeeds', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockClear()
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const validPrivateKey = env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64
	env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64 =
		Buffer.from('invalid-pkcs8').toString('base64')
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const objectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const step = new CachedUploadStep(() => undefined)
	const options = {
		api: {
			fetcher: async (input: RequestInfo | URL) =>
				String(input).endsWith('/export')
					? exportEnvelope('complete')
					: identityEnvelope(1_000),
			sleep: async () => undefined,
		},
		downloadFetcher: async () =>
			new Response('valid', { headers: { 'content-length': '5' } }),
	}
	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: workflowInstanceId(DATABASE_ID, payload.day),
				payload,
				timestamp: new Date('2026-07-22T02:15:01Z'),
			},
			step,
			options,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'manifest-signing-failed',
	)
	assert.notEqual(await bucket.head(objectKey), null)
	assert.equal(await bucket.head(payload.manifestKey), null)

	env.BACKUP_MANIFEST_SIGNING_PRIVATE_KEY_PKCS8_BASE64 = validPrivateKey
	await runBackupRuntime(
		env,
		{
			instanceId: workflowInstanceId(DATABASE_ID, payload.day),
			payload,
			timestamp: new Date('2026-07-22T02:15:01Z'),
		},
		step,
		options,
	)
	assert.notEqual(await bucket.head(payload.manifestKey), null)
	assert.equal(consoleError.mock.calls.length, 1)
})
