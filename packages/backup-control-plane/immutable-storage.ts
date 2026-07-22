import { BackupError } from './backup-policy.ts'
import { type BackupManifest, type StoredBackup } from './backup-types.ts'

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

async function inspectExisting(
	bucket: R2Bucket,
	key: string,
): Promise<StoredBackup> {
	const object = await bucket.get(key)
	if (object === null) {
		throw new BackupError(
			'immutable-put-race',
			'immutable object lost after a failed precondition',
			true,
		)
	}
	const digest = await digestBody(object.body, object.size)
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
	if (existing !== null) return inspectExisting(bucket, key)

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

	let streamedBytes = 0
	const validated = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				streamedBytes += chunk.byteLength
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
	const fixed = validated.pipeThrough(new FixedLengthStream(expectedBytes))
	const [r2Body, digestBodyStream] = fixed.tee()
	const digestPromise = digestBody(digestBodyStream, expectedBytes)
	let object: R2Object | null
	try {
		;[object] = await Promise.all([
			bucket.put(key, r2Body, {
				onlyIf: { etagDoesNotMatch: '*' },
				httpMetadata: { contentType: 'application/sql' },
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
	if (object === null) return inspectExisting(bucket, key)
	const digest = await digestPromise
	return {
		...digest,
		r2Etag: object.etag,
		alreadyExisted: false,
	}
}

function stableManifest(manifest: BackupManifest): string {
	return `${JSON.stringify(manifest)}\n`
}

export async function putImmutableManifest(
	bucket: R2Bucket,
	key: string,
	manifest: BackupManifest,
): Promise<void> {
	const body = stableManifest(manifest)
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
): Promise<void> {
	if (!stored.alreadyExisted) return
	const manifest = await readManifest(bucket, manifestKey)
	if (manifest === null) {
		throw new BackupError(
			'duplicate-object-manifest-missing',
			'immutable backup object exists without its canonical manifest',
		)
	}
	if (
		manifest.objectKey !== objectKey ||
		manifest.bytes !== stored.bytes ||
		manifest.sha256 !== stored.sha256 ||
		manifest.r2Etag !== stored.r2Etag
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
		return (await object.json()) as BackupManifest
	} catch {
		throw new BackupError('manifest-corrupt', 'backup manifest JSON is corrupt')
	}
}
