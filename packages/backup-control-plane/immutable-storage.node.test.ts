import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test } from 'vitest'

import {
	MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES,
	assertDuplicateMatchesManifest,
	createSqlStatementScanner,
	putImmutableManifest,
	readManifest,
	storeSignedDownload,
} from './immutable-storage.ts'
import { BackupError, objectKeyForBookmark } from './backup-policy.ts'
import {
	DATABASE_ID,
	MemoryBucket,
	manifest,
} from './backup-control-plane-test-support.ts'

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
		async () =>
			new Response(bytes, {
				headers: { 'content-length': String(bytes.byteLength) },
			}),
	)
	assert.equal(duplicate.alreadyExisted, true)
	assert.equal(duplicate.sha256, stored.sha256)
})

test('a missing manifest is finalized from the durable upload-step digest', async () => {
	const bucket = new MemoryBucket()
	const prefix = `daily/d1/${DATABASE_ID}/2026-07-22`
	const manifestKey = `${prefix}/manifest.json`
	const objectKey = objectKeyForBookmark(prefix, 'bookmark-1')
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		objectKey,
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	// Finalization verifies the stored object against the upload-step
	// result; it never re-downloads from D1 (an expired poll can only be
	// refreshed by exporting a newer database state).
	await assert.doesNotReject(
		assertDuplicateMatchesManifest(
			bucket as unknown as R2Bucket,
			manifestKey,
			objectKey,
			stored,
		),
	)
	await assert.rejects(
		assertDuplicateMatchesManifest(
			bucket as unknown as R2Bucket,
			manifestKey,
			`${prefix}/backup-missing.sql`,
			stored,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'stored-object-missing',
	)
	bucket.corrupt(objectKey, 'other')
	await assert.rejects(
		assertDuplicateMatchesManifest(
			bucket as unknown as R2Bucket,
			manifestKey,
			objectKey,
			stored,
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'stored-object-mismatch',
	)
})

test('an orphaned object from a crashed run does not block a later manifest', async () => {
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
		payload: {
			...manifest(recovered).payload,
			export: {
				...manifest(recovered).payload.export,
				bookmark: 'bookmark-2',
			},
			sql: { ...manifest(recovered).payload.sql, objectKey: recoveryKey },
		},
	})
	assert.equal(
		(await readManifest(bucket as unknown as R2Bucket, manifestKey))?.payload
			.sql.objectKey,
		recoveryKey,
	)
	assert.notEqual(await bucket.head(orphanKey), null)
})

test('sql statement stats measure quote-aware statement lengths during upload', async () => {
	const bucket = new MemoryBucket()
	// Two statements: the second hides semicolons and an escaped quote
	// inside a string literal, and spans multiple lines.
	const sql = `CREATE TABLE t (v TEXT);\nINSERT INTO t VALUES ('semi;colon''s\nnewline');\n`
	const bytes = new TextEncoder().encode(sql)
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'stats.sql',
		'https://download.example',
		async () =>
			new Response(bytes, {
				headers: { 'content-length': String(bytes.byteLength) },
			}),
	)
	assert.deepEqual(stored.sqlStatementStats, {
		maxStatementBytes: new TextEncoder().encode(
			`\nINSERT INTO t VALUES ('semi;colon''s\nnewline');`,
		).byteLength,
		oversizedStatementCount: 0,
		limit: 100_000,
	})

	const scanner = createSqlStatementScanner(10)
	scanner.update(new TextEncoder().encode("INSERT INTO t VALUES ('long"))
	scanner.update(new TextEncoder().encode("er than limit');\nSELECT 1;"))
	assert.deepEqual(scanner.finish(), {
		maxStatementBytes: 43,
		oversizedStatementCount: 1,
		limit: 10,
	})

	const exactLimitScanner = createSqlStatementScanner(10)
	exactLimitScanner.update(new TextEncoder().encode('SELECT 12;'))
	assert.deepEqual(exactLimitScanner.finish(), {
		maxStatementBytes: 10,
		oversizedStatementCount: 0,
		limit: 10,
	})
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

test('direct existing-object mismatch with the signed source fails explicitly', async () => {
	const bucket = new MemoryBucket()
	await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	await assert.rejects(
		storeSignedDownload(
			bucket as unknown as R2Bucket,
			'backup.sql',
			'https://download.example',
			async () => new Response('other', { headers: { 'content-length': '5' } }),
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'existing-object-source-mismatch' &&
			error.retryable === false,
	)
})

test('existing objects do not bypass signed source availability and size validation', async () => {
	const bucket = new MemoryBucket()
	await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	const failures: Array<{
		code: string
		fetcher: typeof fetch
	}> = [
		{
			code: 'download-interrupted',
			fetcher: async () => {
				throw new Error('source unavailable')
			},
		},
		{
			code: 'download-http-error',
			fetcher: async () => new Response('', { status: 403 }),
		},
		{
			code: 'download-truncated',
			fetcher: async () =>
				new Response('abc', { headers: { 'content-length': '5' } }),
		},
		{
			code: 'download-too-large',
			fetcher: async () =>
				new Response('', {
					headers: {
						'content-length': String(MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES),
					},
				}),
		},
	]
	for (const { code, fetcher } of failures) {
		await assert.rejects(
			storeSignedDownload(
				bucket as unknown as R2Bucket,
				'backup.sql',
				'https://download.example',
				fetcher,
			),
			(error: unknown) => error instanceof BackupError && error.code === code,
		)
	}
})

test('conditional-put races compare the winning object with the signed source', async () => {
	const bucket = new MemoryBucket()
	bucket.raceOnNextPut('backup.sql', 'other')
	await assert.rejects(
		storeSignedDownload(
			bucket as unknown as R2Bucket,
			'backup.sql',
			'https://download.example',
			async () => new Response('valid', { headers: { 'content-length': '5' } }),
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'existing-object-source-mismatch',
	)
	assert.equal(bucket.puts.length, 1)
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
						'content-length': String(MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES),
					},
				}),
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'download-too-large',
	)
})

test('zero-byte export is retryable and never stored', async () => {
	const bucket = new MemoryBucket()
	await assert.rejects(
		storeSignedDownload(
			bucket as unknown as R2Bucket,
			'empty.sql',
			'https://download.example',
			async () => new Response('', { headers: { 'content-length': '0' } }),
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'download-empty' &&
			error.retryable,
	)
	assert.equal(await bucket.head('empty.sql'), null)
	assert.equal(bucket.puts.length, 0)
})

test('pre-existing object at the size limit cannot be resumed into a manifest', async () => {
	const bucket = new MemoryBucket()
	await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'oversized-existing.sql',
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	bucket.setReportedSize(
		'oversized-existing.sql',
		MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES,
	)
	await assert.rejects(
		storeSignedDownload(
			bucket as unknown as R2Bucket,
			'oversized-existing.sql',
			'https://download.example',
			async () => new Response('valid', { headers: { 'content-length': '5' } }),
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
			payload: { ...first.payload, buildCommit: 'different' },
		}),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'manifest-conflict',
	)
	assert.equal(
		(await readManifest(bucket as unknown as R2Bucket, 'manifest.json'))
			?.payload.buildCommit,
		'abc123',
	)
})

test('manifest reader rejects valid JSON with an invalid schema', async () => {
	const bucket = new MemoryBucket()
	await bucket.put('manifest.json', JSON.stringify({ schemaVersion: 1 }))
	await assert.rejects(
		readManifest(bucket as unknown as R2Bucket, 'manifest.json'),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'manifest-corrupt',
	)
})

test('an existing source-matched object must also match its immutable manifest', async () => {
	const bucket = new MemoryBucket()
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	const originalManifest = manifest(stored)
	const recorded = {
		...originalManifest,
		payload: {
			...originalManifest.payload,
			sql: { ...originalManifest.payload.sql, objectKey: 'backup.sql' },
		},
	}
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		'manifest.json',
		recorded,
	)
	const matchingDuplicate = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		'backup.sql',
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	await assertDuplicateMatchesManifest(
		bucket as unknown as R2Bucket,
		'manifest.json',
		'backup.sql',
		matchingDuplicate,
	)
	await assert.rejects(
		assertDuplicateMatchesManifest(
			bucket as unknown as R2Bucket,
			'manifest.json',
			'other-backup.sql',
			matchingDuplicate,
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'duplicate-object-manifest-mismatch',
	)
})
