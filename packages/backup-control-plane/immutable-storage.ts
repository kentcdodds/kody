import {
	parseBackupManifest,
	serializeBackupManifest,
} from '@kody-internal/shared/backup-manifest.ts'

import { BackupError } from './backup-policy.ts'
import { type BackupManifest, type StoredBackup } from './backup-types.ts'

export const MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES = 5 * 1024 * 1024 * 1024

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function digestBody(
	body: ReadableStream<Uint8Array>,
	expectedBytes?: number,
): Promise<{ bytes: number; sha256: string }> {
	const digest = new DigestStream('SHA-256')
	await body.pipeTo(digest)
	const bytes = Number(digest.bytesWritten)
	if (expectedBytes !== undefined && bytes !== expectedBytes) {
		throw new BackupError(
			'download-truncated',
			'download byte count did not match Content-Length',
			true,
		)
	}
	return { bytes, sha256: hex(await digest.digest) }
}

interface SignedDownload {
	body: ReadableStream<Uint8Array>
	expectedBytes: number
}

async function fetchSignedDownload(
	signedUrl: string,
	fetcher: typeof fetch,
): Promise<SignedDownload> {
	let response: Response
	try {
		response = await fetcher(signedUrl)
	} catch {
		throw new BackupError(
			'download-interrupted',
			'signed export download was interrupted',
			true,
		)
	}
	if (!response.ok || response.body === null) {
		throw new BackupError(
			'download-http-error',
			`signed export download returned HTTP ${response.status}`,
			response.status === 429 || response.status >= 500,
		)
	}
	const contentLength = response.headers.get('content-length')
	if (contentLength === null || !/^\d+$/.test(contentLength)) {
		throw new BackupError(
			'download-missing-length',
			'signed export download lacked a valid Content-Length',
			true,
		)
	}
	const expectedBytes = Number(contentLength)
	if (!Number.isSafeInteger(expectedBytes)) {
		throw new BackupError(
			'download-invalid-length',
			'signed export Content-Length exceeded safe limits',
		)
	}
	if (expectedBytes === 0) {
		throw new BackupError('download-empty', 'export download is empty', true)
	}
	if (expectedBytes >= MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES) {
		throw new BackupError(
			'download-too-large',
			'export exceeds the single-object backup size limit',
		)
	}

	let streamedBytes = 0
	const validated = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				streamedBytes += chunk.byteLength
				if (streamedBytes > expectedBytes) {
					throw new BackupError(
						'download-truncated',
						'download byte count did not match Content-Length',
						true,
					)
				}
				controller.enqueue(chunk)
			},
			flush() {
				if (streamedBytes !== expectedBytes) {
					throw new BackupError(
						'download-truncated',
						'download byte count did not match Content-Length',
						true,
					)
				}
			},
		}),
	)
	return {
		body: validated.pipeThrough(new FixedLengthStream(expectedBytes)),
		expectedBytes,
	}
}

async function inspectExisting(
	bucket: R2Bucket,
	key: string,
	sourceDigestPromise: Promise<{ bytes: number; sha256: string }>,
): Promise<StoredBackup> {
	const object = await bucket.get(key)
	if (object === null) {
		await sourceDigestPromise.catch(() => undefined)
		throw new BackupError(
			'immutable-put-race',
			'immutable object lost after a failed precondition',
			true,
		)
	}
	if (object.size >= MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES) {
		await sourceDigestPromise.catch(() => undefined)
		throw new BackupError(
			'download-too-large',
			'existing export is at or above the single-object backup size limit',
		)
	}
	let digest: { bytes: number; sha256: string }
	let sourceDigest: { bytes: number; sha256: string }
	try {
		;[digest, sourceDigest] = await Promise.all([
			digestBody(object.body, object.size),
			sourceDigestPromise,
		])
	} catch (error) {
		if (error instanceof BackupError) throw error
		throw new BackupError(
			'download-interrupted',
			'streaming the signed export for immutable comparison failed',
			true,
		)
	}
	if (
		digest.bytes !== sourceDigest.bytes ||
		digest.sha256 !== sourceDigest.sha256
	) {
		throw new BackupError(
			'existing-object-source-mismatch',
			'existing immutable object does not match the signed export source',
		)
	}
	return {
		...digest,
		r2Etag: object.etag,
		alreadyExisted: true,
	}
}

export async function storeSignedDownload(
	bucket: R2Bucket,
	key: string,
	signedUrl: string,
	fetcher: typeof fetch = fetch,
): Promise<StoredBackup> {
	const existing = await bucket.head(key)
	const download = await fetchSignedDownload(signedUrl, fetcher)
	if (existing !== null) {
		return inspectExisting(
			bucket,
			key,
			digestBody(download.body, download.expectedBytes),
		)
	}

	const [r2Body, digestBodyStream] = download.body.tee()
	const digestPromise = digestBody(digestBodyStream, download.expectedBytes)
	let object: R2Object | null
	try {
		;[object] = await Promise.all([
			bucket
				.put(key, r2Body, {
					onlyIf: { etagDoesNotMatch: '*' },
					httpMetadata: { contentType: 'application/sql' },
				})
				.then(async (result) => {
					if (result === null && !r2Body.locked) await r2Body.cancel()
					return result
				}),
			digestPromise,
		])
	} catch (error) {
		if (error instanceof BackupError) throw error
		throw new BackupError(
			'download-interrupted',
			'streaming the export to immutable storage failed',
			true,
		)
	}
	if (object === null) return inspectExisting(bucket, key, digestPromise)
	const digest = await digestPromise
	return {
		...digest,
		r2Etag: object.etag,
		alreadyExisted: false,
	}
}

export async function putImmutableManifest(
	bucket: R2Bucket,
	key: string,
	manifest: BackupManifest,
): Promise<void> {
	const body = serializeBackupManifest(manifest)
	const result = await bucket.put(key, body, {
		onlyIf: { etagDoesNotMatch: '*' },
		httpMetadata: { contentType: 'application/json' },
	})
	if (result !== null) return
	const existing = await bucket.get(key)
	if (existing === null) {
		throw new BackupError(
			'manifest-put-race',
			'manifest disappeared after immutable put conflict',
			true,
		)
	}
	if ((await existing.text()) !== body) {
		throw new BackupError(
			'manifest-conflict',
			'immutable manifest differs from this workflow result',
		)
	}
}

export async function assertDuplicateMatchesManifest(
	bucket: R2Bucket,
	manifestKey: string,
	objectKey: string,
	stored: StoredBackup,
	signedSource?: {
		signedUrl: string
		fetcher?: typeof fetch
	},
): Promise<void> {
	const manifest = await readManifest(bucket, manifestKey)
	if (manifest === null) {
		if (!signedSource) {
			throw new BackupError(
				'duplicate-object-manifest-missing',
				'backup object has no manifest and no signed source verification',
			)
		}
		const download = await fetchSignedDownload(
			signedSource.signedUrl,
			signedSource.fetcher ?? fetch,
		)
		const verified = await inspectExisting(
			bucket,
			objectKey,
			digestBody(download.body, download.expectedBytes),
		)
		if (
			verified.bytes !== stored.bytes ||
			verified.sha256 !== stored.sha256 ||
			verified.r2Etag !== stored.r2Etag
		) {
			throw new BackupError(
				'duplicate-object-source-proof-mismatch',
				'signed source verification does not match the stored step result',
			)
		}
		return
	}
	if (
		manifest.payload.sql.objectKey !== objectKey ||
		manifest.payload.sql.bytes !== stored.bytes ||
		manifest.payload.sql.sha256 !== stored.sha256 ||
		manifest.payload.sql.r2Etag !== stored.r2Etag
	) {
		throw new BackupError(
			'duplicate-object-manifest-mismatch',
			'immutable backup object does not match its existing manifest',
		)
	}
}

export async function readManifest(
	bucket: R2Bucket,
	key: string,
): Promise<BackupManifest | null> {
	const object = await bucket.get(key)
	if (object === null) return null
	try {
		const value = await object.json<unknown>()
		const manifest = parseBackupManifest(value)
		if (manifest.payload.sql.bytes >= MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES) {
			throw new Error('backup manifest exceeds single-object size limit')
		}
		return manifest
	} catch {
		throw new BackupError('manifest-corrupt', 'backup manifest JSON is corrupt')
	}
}
