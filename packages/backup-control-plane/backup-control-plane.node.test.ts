import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test } from 'vitest'

import {
	DEFAULT_BACKUP_MAX_SOURCE_BYTES,
	startD1Export,
	verifySourceDatabaseIdentity,
} from './d1-export-api.ts'
import { runBackupRuntime, type BackupRuntimeStep } from './backup-runtime.ts'
import { runDurableExport, type DurableExportStep } from './durable-export.ts'
import { checkFreshness } from './freshness-check.ts'
import {
	MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES,
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
	objectKeyForBookmark,
	workflowInstanceId,
} from './backup-policy.ts'
import {
	type BackupEnvironment,
	type BackupManifest,
	type BackupPayload,
} from './backup-types.ts'
import {
	enqueueBackup,
	isApprovedRetryWindow,
	retryExistingBackup,
	type WorkflowInstanceStatus,
} from './workflow-trigger.ts'

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

class RetryAfterCommitStep implements BackupRuntimeStep {
	readonly uploadResults: boolean[] = []
	private readonly cache = new Map<string, unknown>()

	async do<T>(
		name: string,
		config: unknown,
		callback: () => Promise<T>,
	): Promise<T>
	async do<T>(name: string, callback: () => Promise<T>): Promise<T>
	async do<T>(
		name: string,
		configOrCallback: unknown,
		callback?: () => Promise<T>,
	): Promise<T> {
		if (this.cache.has(name)) return this.cache.get(name) as T
		const execute =
			typeof configOrCallback === 'function'
				? (configOrCallback as () => Promise<T>)
				: callback!
		if (name === 'stream-export-to-immutable-r2') {
			try {
				const discarded = await execute()
				this.uploadResults.push(
					(discarded as { alreadyExisted: boolean }).alreadyExisted,
				)
				throw new Error('simulated Workflow failure before step persistence')
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.message !== 'simulated Workflow failure before step persistence'
				) {
					throw error
				}
			}
			const retried = await execute()
			this.uploadResults.push(
				(retried as { alreadyExisted: boolean }).alreadyExisted,
			)
			this.cache.set(name, retried)
			return retried
		}
		const value = await execute()
		this.cache.set(name, value)
		return value
	}

	async sleep(): Promise<void> {}
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

function identityEnvelope(fileSize: unknown, includeSize = true): Response {
	return Response.json({
		success: true,
		result: {
			uuid: DATABASE_ID,
			name: 'production-db',
			...(includeSize ? { file_size: fileSize } : {}),
		},
	})
}

function identityApi(fileSize = 1_000) {
	return {
		fetcher: async () => identityEnvelope(fileSize),
		sleep: async () => undefined,
	}
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
		objectKey: objectKeyForBookmark(
			`daily/d1/${DATABASE_ID}/2026-07-22`,
			'bookmark-1',
		),
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
	assert.equal(daily.objectPrefix, sameDay.objectPrefix)
	assert.equal(daily.manifestKey, sameDay.manifestKey)
	assert.equal(daily.objectPrefix, `daily/d1/${DATABASE_ID}/2026-07-22`)
	assert.match(
		objectKeyForBookmark(daily.objectPrefix, 'bookmark-1'),
		new RegExp(`^daily/d1/${DATABASE_ID}/2026-07-22/backup-[0-9a-f]+\\.sql$`),
	)
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

test('bookmark-derived keys reject unsafe bookmark path input', () => {
	const prefix = `daily/d1/${DATABASE_ID}/2026-07-22`
	for (const bookmark of [
		'',
		'.',
		'..',
		'../escape',
		'slash/value',
		'line\n',
	]) {
		assert.throws(
			() => objectKeyForBookmark(prefix, bookmark),
			(error: unknown) =>
				error instanceof BackupError && error.code === 'unsafe-export-bookmark',
		)
	}
	assert.equal(
		objectKeyForBookmark(prefix, 'bookmark-1'),
		objectKeyForBookmark(prefix, 'bookmark-1'),
	)
	assert.notEqual(
		objectKeyForBookmark(prefix, 'bookmark-1'),
		objectKeyForBookmark(prefix, 'bookmark-2'),
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
				result: {
					uuid: DATABASE_ID,
					name: 'production-db',
					file_size: 1_000,
				},
			})
		},
		sleep: async () => undefined,
	})
	assert.equal(urls.length, 1)
	assert.match(urls[0]!, /\/d1\/database\//)
})

test('requires an integer D1 file size and accepts the byte below the ceiling', async () => {
	for (const response of [
		identityEnvelope(undefined, false),
		identityEnvelope('1000'),
		identityEnvelope(1.5),
		identityEnvelope(-1),
	]) {
		await assert.rejects(
			verifySourceDatabaseIdentity(environment(), {
				fetcher: async () => response.clone(),
			}),
			(error: unknown) =>
				error instanceof BackupError && error.code === 'api-malformed-identity',
		)
	}
	const result = await verifySourceDatabaseIdentity(environment(), {
		fetcher: async () => identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES - 1),
	})
	assert.deepEqual(result, {
		fileSize: DEFAULT_BACKUP_MAX_SOURCE_BYTES - 1,
		maxSourceBytes: DEFAULT_BACKUP_MAX_SOURCE_BYTES,
	})
})

test('rejects D1 size at or above the configured ceiling', async () => {
	for (const fileSize of [
		DEFAULT_BACKUP_MAX_SOURCE_BYTES,
		DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1,
	]) {
		await assert.rejects(
			verifySourceDatabaseIdentity(environment(), {
				fetcher: async () => identityEnvelope(fileSize),
			}),
			(error: unknown) =>
				error instanceof BackupError &&
				error.code === 'source-size-limit-exceeded',
		)
	}
	const env = environment()
	env.BACKUP_MAX_SOURCE_BYTES = '100'
	await assert.rejects(
		verifySourceDatabaseIdentity(env, {
			fetcher: async () => identityEnvelope(100),
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-limit-exceeded',
	)
	env.BACKUP_MAX_SOURCE_BYTES = String(DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1)
	await assert.rejects(
		verifySourceDatabaseIdentity(env, {
			fetcher: async () => identityEnvelope(1),
		}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'invalid-max-source-bytes',
	)
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

test('workflow retry reuses an upload committed before step persistence and writes the absent manifest', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const step = new RetryAfterCommitStep()
	const apiCalls: string[] = []
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
					return url.endsWith('/export')
						? exportEnvelope('complete')
						: identityEnvelope(1_000)
				},
				sleep: async () => undefined,
			},
			downloadFetcher: async () =>
				new Response('valid', { headers: { 'content-length': '5' } }),
		},
	)
	assert.deepEqual(step.uploadResults, [false, true])
	assert.equal(apiCalls.filter((url) => url.endsWith('/export')).length, 1)
	assert.equal(
		result.objectKey,
		objectKeyForBookmark(payload.objectPrefix, 'bookmark-1'),
	)
	assert.deepEqual(
		await readManifest(bucket as unknown as R2Bucket, payload.manifestKey),
		result,
	)
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

test('an existing object without a manifest is recoverable', async () => {
	const bucket = new MemoryBucket()
	const prefix = `daily/d1/${DATABASE_ID}/2026-07-22`
	const manifestKey = `${prefix}/manifest.json`
	const orphanKey = objectKeyForBookmark(prefix, 'bookmark-1')
	await storeSignedDownload(
		bucket as unknown as R2Bucket,
		orphanKey,
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	const duplicate = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		orphanKey,
		'https://download.example',
		async () => {
			throw new Error('existing immutable object must not redownload')
		},
	)
	await assert.doesNotReject(
		assertDuplicateMatchesManifest(
			bucket as unknown as R2Bucket,
			manifestKey,
			orphanKey,
			duplicate,
		),
	)
	const recoveryKey = objectKeyForBookmark(prefix, 'bookmark-2')
	const recovered = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		recoveryKey,
		'https://download.example',
		async () => new Response('newer', { headers: { 'content-length': '5' } }),
	)
	assert.equal(recovered.alreadyExisted, false)
	await putImmutableManifest(bucket as unknown as R2Bucket, manifestKey, {
		...manifest(recovered),
		bookmark: 'bookmark-2',
		objectKey: recoveryKey,
	})
	assert.equal(
		(await readManifest(bucket as unknown as R2Bucket, manifestKey))?.objectKey,
		recoveryKey,
	)
	assert.notEqual(await bucket.head(orphanKey), null)
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
	await assert.rejects(
		storeSignedDownload(
			new MemoryBucket() as unknown as R2Bucket,
			'too-large.sql',
			'https://download.example',
			async () =>
				new Response('', {
					headers: {
						'content-length': String(MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES + 1),
					},
				}),
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'download-too-large',
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

test('freshness accepts matching metadata and flags size/ETag drift or missing objects', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const key = objectKeyForBookmark(
		`daily/d1/${DATABASE_ID}/2026-07-22`,
		'bookmark-1',
	)
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
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), identityApi()),
		true,
	)
	bucket.corrupt(key, 'drift')
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), identityApi()),
		false,
	)
	bucket.corrupt(key, 'longer')
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), identityApi()),
		false,
	)
	assert.equal(
		await checkFreshness(
			environment(new MemoryBucket()),
			new Date('2026-07-22T03:45:00Z'),
			identityApi(),
		),
		false,
	)
})

test('hourly freshness queries live D1 size and fails at the ceiling', async () => {
	let metadataRequests = 0
	await assert.rejects(
		checkFreshness(environment(), new Date('2026-07-22T03:45:00Z'), {
			fetcher: async () => {
				metadataRequests += 1
				return identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES)
			},
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-limit-exceeded',
	)
	assert.equal(metadataRequests, 1)
})

test('workflow does not start D1 export when source size exceeds the ceiling', async () => {
	const env = environment()
	const payload = backupPayload(env, new Date('2026-07-22T02:15:00Z'))
	const urls: string[] = []
	await assert.rejects(
		runBackupRuntime(
			env,
			{
				instanceId: workflowInstanceId(DATABASE_ID, payload.day),
				payload,
				timestamp: new Date('2026-07-22T02:15:01Z'),
			},
			new RetryAfterCommitStep(),
			{
				api: {
					fetcher: async (input) => {
						urls.push(String(input))
						return identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES + 1)
					},
				},
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-limit-exceeded',
	)
	assert.equal(urls.length, 1)
	assert.equal(
		urls.some((url) => url.endsWith('/export')),
		false,
	)
})

test('workflow creation omits explicit retention and active overlap stays duplicate', async () => {
	let createdOptions: { id: string; params: BackupPayload } | undefined
	const workflow = {
		async create(options: { id: string; params: BackupPayload }) {
			if (createdOptions) throw new Error('instance already exists')
			createdOptions = options
		},
		async get() {
			return {
				status: async () => ({ status: 'running' as const }),
				restart: async () => undefined,
			}
		},
	}
	const payload = backupPayload(environment(), new Date('2026-07-22T02:15:00Z'))
	assert.equal(await enqueueBackup(workflow, DATABASE_ID, payload), 'created')
	assert.equal('retention' in createdOptions!, false)
	assert.equal(await enqueueBackup(workflow, DATABASE_ID, payload), 'duplicate')
})

for (const status of [
	'queued',
	'running',
	'paused',
	'complete',
	'waiting',
	'waitingForPause',
] as const) {
	test(`${status} workflow instances are not restarted`, async () => {
		let restarts = 0
		const workflow = {
			async create() {
				throw new Error('instance already exists')
			},
			async get() {
				return {
					status: async () => ({ status }),
					restart: async () => {
						restarts += 1
					},
				}
			},
		}
		assert.equal(
			await enqueueBackup(
				workflow,
				DATABASE_ID,
				backupPayload(environment(), new Date('2026-07-22T02:15:00Z')),
			),
			'duplicate',
		)
		assert.equal(restarts, 0)
	})
}

for (const status of ['errored', 'terminated'] as const) {
	test(`${status} workflow instances are restarted once`, async () => {
		let restarts = 0
		const workflow = {
			async create() {
				throw new Error('instance already exists')
			},
			async get() {
				return {
					status: async () => ({ status }),
					restart: async () => {
						restarts += 1
					},
				}
			},
		}
		assert.equal(
			await enqueueBackup(
				workflow,
				DATABASE_ID,
				backupPayload(environment(), new Date('2026-07-22T02:15:00Z')),
			),
			'restarted',
		)
		assert.equal(restarts, 1)
	})
}

for (const status of ['unknown', 'unexpected'] as const) {
	test(`${status} workflow status fails closed`, async () => {
		let restarts = 0
		const workflow = {
			async create() {
				throw new Error('original create failure')
			},
			async get() {
				return {
					status: async () => ({
						status: status as WorkflowInstanceStatus,
					}),
					restart: async () => {
						restarts += 1
					},
				}
			},
		}
		await assert.rejects(
			enqueueBackup(
				workflow,
				DATABASE_ID,
				backupPayload(environment(), new Date('2026-07-22T02:15:00Z')),
			),
			/original create failure/,
		)
		assert.equal(restarts, 0)
	})
}

test('hourly freshness retries are bounded to 02:45 through 05:45 UTC', () => {
	for (const hour of [2, 3, 4, 5]) {
		assert.equal(
			isApprovedRetryWindow(
				new Date(`2026-07-22T${String(hour).padStart(2, '0')}:45:00Z`),
			),
			true,
		)
	}
	assert.equal(isApprovedRetryWindow(new Date('2026-07-22T01:45:00Z')), false)
	assert.equal(isApprovedRetryWindow(new Date('2026-07-22T06:45:00Z')), false)
	assert.equal(isApprovedRetryWindow(new Date('2026-07-22T03:44:00Z')), false)
})

test('existing-only retry restarts a later failure without creating', async () => {
	let creates = 0
	let restarts = 0
	const workflow = {
		async create() {
			creates += 1
		},
		async get() {
			return {
				status: async () => ({ status: 'errored' as const }),
				restart: async () => {
					restarts += 1
				},
			}
		},
	}
	assert.equal(
		await retryExistingBackup(workflow, DATABASE_ID, '2026-07-22'),
		'restarted',
	)
	assert.equal(creates, 0)
	assert.equal(restarts, 1)
})

test('existing-only retry does not create a missing deterministic instance', async () => {
	let creates = 0
	const workflow = {
		async create() {
			creates += 1
		},
		async get() {
			throw new Error('instance missing')
		},
	}
	assert.equal(
		await retryExistingBackup(workflow, DATABASE_ID, '2026-07-22'),
		'missing',
	)
	assert.equal(creates, 0)
})

test('existing-only retry leaves active/complete alone and fails closed on unknown', async () => {
	for (const status of ['running', 'complete'] as const) {
		let restarts = 0
		const workflow = {
			async get() {
				return {
					status: async () => ({ status }),
					restart: async () => {
						restarts += 1
					},
				}
			},
		}
		assert.equal(
			await retryExistingBackup(workflow, DATABASE_ID, '2026-07-22'),
			'duplicate',
		)
		assert.equal(restarts, 0)
	}
	await assert.rejects(
		retryExistingBackup(
			{
				async get() {
					return {
						status: async () => ({ status: 'unknown' as const }),
						restart: async () => undefined,
					}
				},
			},
			DATABASE_ID,
			'2026-07-22',
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'workflow-status-unknown',
	)
})
