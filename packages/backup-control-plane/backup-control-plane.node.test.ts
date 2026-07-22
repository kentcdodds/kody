import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test } from 'vitest'

import { startD1Export, verifySourceDatabaseIdentity } from './d1-export-api.ts'
import { runDurableExport, type DurableExportStep } from './durable-export.ts'
import { checkFreshness } from './freshness-check.ts'
import {
	assertDuplicateMatchesManifest,
	putImmutableManifest,
	readManifest,
	storeSignedDownload,
} from './immutable-storage.ts'
import {
	BackupError,
	assertRemoteDatabaseIdentity,
	backupPayload,
	isBackupEnabled,
	workflowInstanceId,
} from './backup-policy.ts'
import {
	type BackupEnvironment,
	type BackupManifest,
	type BackupPayload,
} from './backup-types.ts'
import { enqueueBackup } from './workflow-trigger.ts'

class TestDigestStream extends WritableStream<Uint8Array> {
	readonly digest: Promise<ArrayBuffer>
	private readonly bytes: () => number

	constructor() {
		const hash = createHash('sha256')
		let byteCount = 0
		let resolveDigest: (value: ArrayBuffer) => void = () => undefined
		const digest = new Promise<ArrayBuffer>((resolve) => {
			resolveDigest = resolve
		})
		super({
			write(chunk) {
				const bytes = new Uint8Array(
					chunk.buffer,
					chunk.byteOffset,
					chunk.byteLength,
				)
				byteCount += bytes.byteLength
				hash.update(bytes)
			},
			close() {
				const result = hash.digest()
				resolveDigest(
					result.buffer.slice(
						result.byteOffset,
						result.byteOffset + result.byteLength,
					),
				)
			},
		})
		this.digest = digest
		this.bytes = () => byteCount
	}

	get bytesWritten(): number {
		return this.bytes()
	}
}

class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
	constructor(expected: number | bigint) {
		let bytes = 0
		super({
			transform(chunk, controller) {
				bytes += chunk.byteLength
				if (bytes > Number(expected)) {
					throw new Error('stream exceeded expected length')
				}
				controller.enqueue(chunk)
			},
			flush() {
				if (bytes !== Number(expected)) {
					throw new Error('stream ended before expected length')
				}
			},
		})
	}
}

Object.assign(globalThis, {
	DigestStream: TestDigestStream,
	FixedLengthStream: TestFixedLengthStream,
})

class MemoryBucket {
	readonly puts: Array<{ key: string; options: R2PutOptions }> = []
	private readonly objects = new Map<string, Uint8Array>()

	async put(
		key: string,
		value: ReadableStream | string,
		options: R2PutOptions = {},
	): Promise<R2Object | null> {
		this.puts.push({ key, options })
		if (
			options.onlyIf &&
			'etagDoesNotMatch' in options.onlyIf &&
			options.onlyIf.etagDoesNotMatch === '*' &&
			this.objects.has(key)
		) {
			return null
		}
		const bytes =
			typeof value === 'string'
				? new TextEncoder().encode(value)
				: new Uint8Array(await new Response(value).arrayBuffer())
		this.objects.set(key, bytes)
		return this.metadata(key)
	}

	async head(key: string): Promise<R2Object | null> {
		return this.objects.has(key) ? this.metadata(key) : null
	}

	async get(key: string): Promise<R2ObjectBody | null> {
		const bytes = this.objects.get(key)
		if (!bytes) return null
		const metadata = this.metadata(key)
		return {
			...metadata,
			body: new Response(bytes as unknown as BodyInit).body!,
			bodyUsed: false,
			arrayBuffer: async () => bytes.buffer.slice(0),
			bytes: async () => bytes.slice(),
			text: async () => new TextDecoder().decode(bytes),
			json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
			blob: async () => new Blob([bytes as unknown as BlobPart]),
			writeHttpMetadata: () => undefined,
		} as R2ObjectBody
	}

	corrupt(key: string, value: string): void {
		this.objects.set(key, new TextEncoder().encode(value))
	}

	private metadata(key: string): R2Object {
		const bytes = this.objects.get(key)!
		return {
			key,
			version: '1',
			size: bytes.byteLength,
			etag: createHash('md5').update(bytes).digest('hex'),
			httpEtag: `"${createHash('md5').update(bytes).digest('hex')}"`,
			uploaded: new Date(0),
			checksums: {},
			customMetadata: {},
			writeHttpMetadata: () => undefined,
			storageClass: 'Standard',
			ssecKeyMd5: undefined,
		} as unknown as R2Object
	}
}

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const DATABASE_ID = '22222222-2222-4222-8222-222222222222'

function environment(bucket = new MemoryBucket()): BackupEnvironment {
	return {
		BACKUP_BUCKET: bucket as unknown as R2Bucket,
		BACKUP_WORKFLOW: {} as Workflow,
		CLOUDFLARE_API_TOKEN: 'not-logged-secret',
		SOURCE_ACCOUNT_ID: ACCOUNT_ID,
		SOURCE_ACCOUNT_NAME: 'production-account',
		SOURCE_DATABASE_ID: DATABASE_ID,
		SOURCE_DATABASE_NAME: 'production-db',
		ALLOWED_SOURCE_ACCOUNT_IDS: ACCOUNT_ID,
		ALLOWED_SOURCE_DATABASE_IDS: DATABASE_ID,
		ENABLE_PRODUCTION_D1_BACKUPS: 'true',
		BACKUP_BENCHMARK_APPROVED: 'true',
		BUILD_COMMIT: 'abc123',
	}
}

class ReplayStep implements DurableExportStep {
	readonly calls: string[] = []
	readonly executions: string[] = []
	readonly sleeps: string[] = []
	private readonly cache = new Map<string, unknown>()
	private interrupted = false
	private readonly interruptAfter: string | undefined

	constructor(interruptAfter?: string) {
		this.interruptAfter = interruptAfter
	}

	async do<T>(
		name: string,
		_config: Parameters<DurableExportStep['do']>[1],
		callback: () => Promise<T>,
	): Promise<T> {
		this.calls.push(name)
		if (this.cache.has(name)) return this.cache.get(name) as T
		this.executions.push(name)
		const value = await callback()
		this.cache.set(name, value)
		if (name === this.interruptAfter && !this.interrupted) {
			this.interrupted = true
			throw new Error('simulated workflow interruption after persisted step')
		}
		return value
	}

	async sleep(name: string): Promise<void> {
		this.sleeps.push(name)
	}
}

function exportEnvelope(
	status?: 'complete' | 'error',
	bookmark = 'bookmark-1',
): Response {
	return Response.json({
		success: true,
		result: {
			type: 'export',
			success: true,
			at_bookmark: bookmark,
			status,
			...(status === 'complete'
				? { result: { signed_url: 'https://download.example/export.sql' } }
				: {}),
			...(status === 'error' ? { error: 'internal detail' } : {}),
		},
	})
}

function manifest(stored: {
	bytes: number
	sha256: string
	r2Etag: string
}): BackupManifest {
	return {
		schemaVersion: 1,
		source: {
			accountId: ACCOUNT_ID,
			accountName: 'production-account',
			databaseId: DATABASE_ID,
			databaseName: 'production-db',
		},
		bookmark: 'bookmark-1',
		scheduledAt: '2026-07-22T02:15:00.000Z',
		startedAt: '2026-07-22T02:15:01.000Z',
		completedAt: '2026-07-22T02:16:00.000Z',
		objectKey: `daily/d1/${DATABASE_ID}/2026-07-22/backup.sql`,
		...stored,
		commit: 'abc123',
		retentionTier: 'daily',
	}
}

test('requires both explicit enable and benchmark approval', () => {
	const env = environment()
	assert.equal(isBackupEnabled(env), true)
	env.BACKUP_BENCHMARK_APPROVED = 'false'
	assert.equal(isBackupEnabled(env), false)
	env.BACKUP_BENCHMARK_APPROVED = 'true'
	env.ENABLE_PRODUCTION_D1_BACKUPS = 'TRUE'
	assert.equal(isBackupEnabled(env), false)
})

test('guards configured account/database allowlists and live D1 UUID/name', () => {
	const env = environment()
	assert.doesNotThrow(() =>
		assertRemoteDatabaseIdentity(env, {
			uuid: DATABASE_ID,
			name: 'production-db',
		}),
	)
	assert.throws(
		() =>
			assertRemoteDatabaseIdentity(env, {
				uuid: DATABASE_ID,
				name: 'wrong-db',
			}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'source-identity-mismatch',
	)
	env.ALLOWED_SOURCE_DATABASE_IDS = '33333333-3333-4333-8333-333333333333'
	assert.throws(
		() =>
			assertRemoteDatabaseIdentity(env, {
				uuid: DATABASE_ID,
				name: 'production-db',
			}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'source-not-allowlisted',
	)
})

test('builds deterministic daily and Sunday-UTC weekly retention keys', () => {
	const env = environment()
	const daily = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const sameDay = backupPayload(env, new Date('2026-07-22T23:59:00Z'))
	assert.equal(daily.day, sameDay.day)
	assert.equal(daily.objectKey, sameDay.objectKey)
	assert.equal(daily.manifestKey, sameDay.manifestKey)
	assert.equal(daily.objectKey, `daily/d1/${DATABASE_ID}/2026-07-22/backup.sql`)
	assert.equal(daily.retentionTier, 'daily')
	assert.equal(
		workflowInstanceId(DATABASE_ID, daily.day),
		`d1-backup-${DATABASE_ID}-2026-07-22`,
	)
	const weekly = backupPayload(env, new Date('2026-07-26T02:15:00Z'))
	assert.equal(weekly.retentionTier, 'weekly')
	assert.equal(
		weekly.manifestKey,
		`weekly/d1/${DATABASE_ID}/2026-07-26/manifest.json`,
	)
})

test('verifies D1 identity without calling the live account endpoint', async () => {
	const env = environment()
	const urls: string[] = []
	await verifySourceDatabaseIdentity(env, {
		fetcher: async (input) => {
			urls.push(String(input))
			return Response.json({
				success: true,
				result: { uuid: DATABASE_ID, name: 'production-db' },
			})
		},
		sleep: async () => undefined,
	})
	assert.equal(urls.length, 1)
	assert.match(urls[0]!, /\/d1\/database\//)
})

test('durable orchestration starts once and resumes numbered polls after interruption', async () => {
	const bodies: string[] = []
	const responses = [
		exportEnvelope(),
		exportEnvelope(),
		exportEnvelope('complete'),
	]
	const step = new ReplayStep('poll-d1-export-1')
	const options = {
		maxPolls: 3,
		pollIntervalSeconds: 1,
		api: {
			fetcher: async (_input: RequestInfo | URL, init?: RequestInit) => {
				bodies.push(String(init?.body))
				return responses.shift()!
			},
			sleep: async () => undefined,
		},
	}
	await assert.rejects(runDurableExport(environment(), step, options))
	const result = await runDurableExport(environment(), step, options)
	assert.equal(result.bookmark, 'bookmark-1')
	assert.equal(
		step.executions.filter((name) => name === 'start-d1-export').length,
		1,
	)
	assert.equal(bodies.length, 3, 'cached start must not call the API on replay')
	assert.deepEqual(JSON.parse(bodies[0]!), { output_format: 'polling' })
	assert.deepEqual(JSON.parse(bodies[1]!), {
		output_format: 'polling',
		current_bookmark: 'bookmark-1',
	})
	assert.deepEqual(step.sleeps, [
		'wait-d1-export-1',
		'wait-d1-export-1',
		'wait-d1-export-2',
	])
})

test('durable polling hard-fails after its bounded numbered poll steps', async () => {
	const step = new ReplayStep()
	await assert.rejects(
		runDurableExport(environment(), step, {
			maxPolls: 2,
			pollIntervalSeconds: 1,
			api: {
				fetcher: async () => exportEnvelope(),
				sleep: async () => undefined,
			},
		}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'export-poll-limit',
	)
	assert.deepEqual(step.calls, [
		'start-d1-export',
		'poll-d1-export-1',
		'poll-d1-export-2',
	])
})

for (const status of [401, 403]) {
	test(`${status} is a non-retryable authentication failure`, async () => {
		let calls = 0
		await assert.rejects(
			startD1Export(environment(), {
				fetcher: async () => {
					calls += 1
					return new Response('', { status })
				},
				sleep: async () => undefined,
			}),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'api-auth-failure' &&
				error.retryable === false,
		)
		assert.equal(calls, 1)
	})
}

for (const status of [429, 500, 503]) {
	test(`${status} retries and then starts the export`, async () => {
		let calls = 0
		const sleeps: number[] = []
		const result = await startD1Export(environment(), {
			fetcher: async () => {
				calls += 1
				return calls === 1
					? new Response('', {
							status,
							headers: status === 429 ? { 'retry-after': '2' } : {},
						})
					: exportEnvelope('complete')
			},
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds)
			},
		})
		assert.equal(result.kind, 'complete')
		assert.equal(calls, 2)
		assert.equal(sleeps[0], status === 429 ? 2_000 : 1_000)
	})
}

test('rejects malformed JSON and malformed/error export payloads', async () => {
	for (const response of [
		new Response('{', { status: 200 }),
		Response.json({ success: true, result: { status: 'complete' } }),
		exportEnvelope('error'),
	]) {
		await assert.rejects(
			startD1Export(environment(), {
				fetcher: async () => response.clone(),
				sleep: async () => undefined,
			}),
			BackupError,
		)
	}
})

test('streams once with an immutable conditional, checksum, byte count, and ETag', async () => {
	const bucket = new MemoryBucket()
	const bytes = new TextEncoder().encode('CREATE TABLE test;\n')
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () =>
			new Response(bytes, {
				headers: { 'content-length': String(bytes.byteLength) },
			}),
	)
	assert.equal(stored.bytes, bytes.byteLength)
	assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'))
	assert.ok(stored.r2Etag)
	assert.deepEqual(bucket.puts[0]?.options.onlyIf, { etagDoesNotMatch: '*' })

	const duplicate = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => {
			throw new Error('duplicate must not redownload')
		},
	)
	assert.equal(duplicate.alreadyExisted, true)
	assert.equal(duplicate.sha256, stored.sha256)
})

test('truncated and interrupted downloads fail retryably, then a retry succeeds', async () => {
	const bucket = new MemoryBucket()
	await assert.rejects(
		storeSignedDownload(
			bucket as unknown as R2Bucket,
			'truncated.sql',
			'https://download.example',
			async () => new Response('abc', { headers: { 'content-length': '5' } }),
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'download-truncated' &&
			error.retryable === true,
	)
	await assert.rejects(
		storeSignedDownload(
			bucket as unknown as R2Bucket,
			'retry.sql',
			'https://download.example',
			async () => {
				throw new Error('connection reset')
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'download-interrupted' &&
			error.retryable,
	)
	const retry = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'retry.sql',
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	assert.equal(retry.bytes, 5)
})

test('download HTTP and malformed length failures have safe retry classification', async () => {
	for (const [status, retryable] of [
		[401, false],
		[403, false],
		[429, true],
		[500, true],
	] as const) {
		await assert.rejects(
			storeSignedDownload(
				new MemoryBucket() as unknown as R2Bucket,
				`${status}.sql`,
				'https://download.example',
				async () => new Response('', { status }),
			),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'download-http-error' &&
				error.retryable === retryable,
		)
	}
	await assert.rejects(
		storeSignedDownload(
			new MemoryBucket() as unknown as R2Bucket,
			'missing-length.sql',
			'https://download.example',
			async () => new Response('data'),
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'download-missing-length' &&
			error.retryable,
	)
})

test('manifest is immutable across duplicate writes and commit changes', async () => {
	const bucket = new MemoryBucket()
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	const first = manifest(stored)
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		'manifest.json',
		first,
	)
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		'manifest.json',
		first,
	)
	await assert.rejects(
		putImmutableManifest(bucket as unknown as R2Bucket, 'manifest.json', {
			...first,
			commit: 'different',
		}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'manifest-conflict',
	)
	assert.equal(
		(await readManifest(bucket as unknown as R2Bucket, 'manifest.json'))
			?.commit,
		'abc123',
	)
})

test('object corruption changes its checksum and conflicts with the immutable manifest', async () => {
	const bucket = new MemoryBucket()
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	const recorded = { ...manifest(stored), objectKey: 'backup.sql' }
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		'manifest.json',
		recorded,
	)
	const matchingDuplicate = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => {
			throw new Error('must inspect existing object')
		},
	)
	await assertDuplicateMatchesManifest(
		bucket as unknown as R2Bucket,
		'manifest.json',
		'backup.sql',
		matchingDuplicate,
	)
	bucket.corrupt('backup.sql', 'evil!')
	const inspected = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => {
			throw new Error('must inspect existing object')
		},
	)
	assert.notEqual(inspected.sha256, stored.sha256)
	await assert.rejects(
		assertDuplicateMatchesManifest(
			bucket as unknown as R2Bucket,
			'manifest.json',
			'backup.sql',
			inspected,
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'duplicate-object-manifest-mismatch',
	)
})

test('freshness check accepts a recent complete backup and flags a missing one', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const key = `daily/d1/${DATABASE_ID}/2026-07-22/backup.sql`
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		key,
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		`daily/d1/${DATABASE_ID}/2026-07-22/manifest.json`,
		manifest(stored),
	)
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z')),
		true,
	)
	assert.equal(
		await checkFreshness(
			environment(new MemoryBucket()),
			new Date('2026-07-22T03:45:00Z'),
		),
		false,
	)
})

test('deterministic workflow ID collapses overlap and duplicate triggers', async () => {
	let creates = 0
	const statuses = new Map<string, string>()
	const workflow = {
		async create(options: { id: string; params: BackupPayload }) {
			creates += 1
			if (statuses.has(options.id)) throw new Error('instance already exists')
			statuses.set(options.id, 'running')
		},
		async get(id: string) {
			return { status: async () => ({ status: statuses.get(id) ?? 'unknown' }) }
		},
	}
	const payload = backupPayload(environment(), new Date('2026-07-22T02:15:00Z'))
	assert.equal(await enqueueBackup(workflow, DATABASE_ID, payload), 'created')
	assert.equal(await enqueueBackup(workflow, DATABASE_ID, payload), 'duplicate')
	assert.equal(creates, 2)
	assert.equal(statuses.size, 1)
})
