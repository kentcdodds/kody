import { createHash } from 'node:crypto'

import { type BackupRuntimeStep } from './backup-runtime.ts'
import { type DurableExportStep } from './durable-export.ts'
import { BackupError, objectKeyForBookmark } from './backup-policy.ts'
import { type BackupEnvironment, type BackupManifest } from './backup-types.ts'
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

export class MemoryBucket {
	readonly puts: Array<{ key: string; options: R2PutOptions }> = []
	private readonly objects = new Map<string, Uint8Array>()
	private readonly reportedSizes = new Map<string, number>()
	private nextPutRace: { key: string; bytes: Uint8Array } | undefined

	async put(
		key: string,
		value: ReadableStream | string,
		options: R2PutOptions = {},
	): Promise<R2Object | null> {
		this.puts.push({ key, options })
		if (this.nextPutRace?.key === key) {
			this.objects.set(key, this.nextPutRace.bytes)
			this.nextPutRace = undefined
		}
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

	setReportedSize(key: string, size: number): void {
		this.reportedSizes.set(key, size)
	}

	raceOnNextPut(key: string, value: string): void {
		this.nextPutRace = { key, bytes: new TextEncoder().encode(value) }
	}

	private metadata(key: string): R2Object {
		const bytes = this.objects.get(key)!
		return {
			key,
			version: '1',
			size: this.reportedSizes.get(key) ?? bytes.byteLength,
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

export const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
export const DATABASE_ID = '22222222-2222-4222-8222-222222222222'

export function environment(bucket = new MemoryBucket()): BackupEnvironment {
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

export class ReplayStep implements DurableExportStep {
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

export class RetryAfterCommitStep implements BackupRuntimeStep {
	readonly uploadResults: boolean[] = []
	private readonly cache = new Map<string, unknown>()
	private readonly afterFirstUpload: (() => void) | undefined

	constructor(afterFirstUpload?: () => void) {
		this.afterFirstUpload = afterFirstUpload
	}

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
				this.afterFirstUpload?.()
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

export class CachedUploadStep implements BackupRuntimeStep {
	private readonly cache = new Map<string, unknown>()
	private readonly afterUpload: () => void
	private readonly afterFinalization?: () => Promise<void>

	constructor(
		afterUpload: () => void,
		afterFinalization?: () => Promise<void>,
	) {
		this.afterUpload = afterUpload
		this.afterFinalization = afterFinalization
	}

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
		const value = await execute()
		this.cache.set(name, value)
		if (name === 'stream-export-to-immutable-r2') this.afterUpload()
		if (
			name === 'verify-source-and-write-immutable-manifest' &&
			this.afterFinalization
		) {
			await this.afterFinalization()
		}
		return value
	}

	async sleep(): Promise<void> {}
}

export class RetryFinalizationStep implements BackupRuntimeStep {
	readonly finalizationAttempts: number[] = []
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
		if (name === 'verify-source-and-write-immutable-manifest') {
			for (let attempt = 1; attempt <= 2; attempt += 1) {
				this.finalizationAttempts.push(attempt)
				try {
					const value = await execute()
					this.cache.set(name, value)
					return value
				} catch (error) {
					if (
						attempt === 2 ||
						!(error instanceof BackupError) ||
						!error.retryable
					) {
						throw error
					}
				}
			}
		}
		const value = await execute()
		this.cache.set(name, value)
		return value
	}

	async sleep(): Promise<void> {}
}

export function exportEnvelope(
	status?: 'complete' | 'error',
	bookmark = 'bookmark-1',
	signedUrl = 'https://download.example/export.sql',
): Response {
	return Response.json({
		success: true,
		result: {
			type: 'export',
			success: true,
			at_bookmark: bookmark,
			status,
			...(status === 'complete' ? { result: { signed_url: signedUrl } } : {}),
			...(status === 'error' ? { error: 'internal detail' } : {}),
		},
	})
}

export function identityEnvelope(
	fileSize: unknown,
	includeSize = true,
): Response {
	return Response.json({
		success: true,
		result: {
			uuid: DATABASE_ID,
			name: 'production-db',
			...(includeSize ? { file_size: fileSize } : {}),
		},
	})
}

export function identityApi(fileSize = 1_000) {
	return {
		fetcher: async () => identityEnvelope(fileSize),
		sleep: async () => undefined,
	}
}

export function manifest(stored: {
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
		bytes: stored.bytes,
		sha256: stored.sha256,
		r2Etag: stored.r2Etag,
		commit: 'abc123',
		retentionTier: 'daily',
	}
}
