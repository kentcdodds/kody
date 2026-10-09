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
import { objectKeyForBookmark } from './backup-policy.ts'
import {
	DATABASE_ID,
	MemoryBucket,
	manifest,
	backupError,
} from './backup-control-plane-test-support.ts'

const r2 = (bucket: MemoryBucket) => bucket as unknown as R2Bucket
const sized = (body: string | Uint8Array<ArrayBuffer>, length?: number) =>
	new Response(body, {
		headers: {
			'content-length': String(
				length ?? (typeof body === 'string' ? body.length : body.byteLength),
			),
		},
	})
const tooLarge = async () => sized('', MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES)

function store(
	bucket: MemoryBucket,
	key: string,
	source: string | typeof fetch = 'valid',
) {
	return storeSignedDownload(
		r2(bucket),
		key,
		'https://download.example',
		typeof source === 'string' ? async () => sized(source) : source,
	)
}

const dayPrefix = `daily/d1/${DATABASE_ID}/2026-07-22`

test('streams once with an immutable conditional, checksum, byte count, and ETag', async () => {
	const bucket = new MemoryBucket()
	const bytes = new TextEncoder().encode('CREATE TABLE test;\n')
	const stored = await store(bucket, 'backup.sql', async () => sized(bytes))
	assert.equal(stored.bytes, bytes.byteLength)
	assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'))
	assert.ok(stored.r2Etag)
	assert.deepEqual(bucket.puts[0]?.options.onlyIf, { etagDoesNotMatch: '*' })

	const duplicate = await store(bucket, 'backup.sql', async () => sized(bytes))
	assert.equal(duplicate.alreadyExisted, true)
	assert.equal(duplicate.sha256, stored.sha256)
})

test('a missing manifest is finalized from the durable upload-step digest', async () => {
	const bucket = new MemoryBucket()
	const manifestKey = `${dayPrefix}/manifest.json`
	const objectKey = objectKeyForBookmark(dayPrefix, 'bookmark-1')
	const stored = await store(bucket, objectKey)
	// Finalization verifies the stored object against the upload-step
	// result; it never re-downloads from D1 (an expired poll can only be
	// refreshed by exporting a newer database state).
	await assert.doesNotReject(
		assertDuplicateMatchesManifest(r2(bucket), manifestKey, objectKey, stored),
	)
	await assert.rejects(
		assertDuplicateMatchesManifest(
			r2(bucket),
			manifestKey,
			`${dayPrefix}/backup-missing.sql`,
			stored,
		),
		backupError('stored-object-missing'),
	)
	bucket.corrupt(objectKey, 'other')
	await assert.rejects(
		assertDuplicateMatchesManifest(r2(bucket), manifestKey, objectKey, stored),
		backupError('stored-object-mismatch'),
	)
})

test('an orphaned object from a crashed run does not block a later manifest', async () => {
	const bucket = new MemoryBucket()
	const manifestKey = `${dayPrefix}/manifest.json`
	const orphanKey = objectKeyForBookmark(dayPrefix, 'bookmark-1')
	await store(bucket, orphanKey)
	const recoveryKey = objectKeyForBookmark(dayPrefix, 'bookmark-2')
	const recovered = await store(bucket, recoveryKey, 'newer')
	assert.equal(recovered.alreadyExisted, false)
	const template = manifest(recovered)
	await putImmutableManifest(r2(bucket), manifestKey, {
		...template,
		payload: {
			...template.payload,
			export: { ...template.payload.export, bookmark: 'bookmark-2' },
			sql: { ...template.payload.sql, objectKey: recoveryKey },
		},
	})
	assert.equal(
		(await readManifest(r2(bucket), manifestKey))?.payload.sql.objectKey,
		recoveryKey,
	)
	assert.notEqual(await bucket.head(orphanKey), null)
})

test('sql statement stats measure quote-aware statement lengths during upload', async () => {
	// Two statements: the second hides semicolons and an escaped quote
	// inside a string literal, and spans multiple lines.
	const sql = `CREATE TABLE t (v TEXT);\nINSERT INTO t VALUES ('semi;colon''s\nnewline');\n`
	const stored = await store(new MemoryBucket(), 'stats.sql', sql)
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

test('new-object download failures have safe retry classification, never store empty exports, and a retry succeeds', async () => {
	const failures: Array<[typeof fetch, string, boolean | undefined]> = [
		[async () => sized('abc', 5), 'download-truncated', true],
		[
			async () => {
				throw new Error('connection reset')
			},
			'download-interrupted',
			true,
		],
		[
			async () => new Response('', { status: 401 }),
			'download-http-error',
			false,
		],
		[
			async () => new Response('', { status: 403 }),
			'download-http-error',
			false,
		],
		[
			async () => new Response('', { status: 429 }),
			'download-http-error',
			true,
		],
		[
			async () => new Response('', { status: 500 }),
			'download-http-error',
			true,
		],
		[async () => new Response('data'), 'download-missing-length', true],
		[tooLarge, 'download-too-large', undefined],
	]
	for (const [fetcher, code, retryable] of failures) {
		await assert.rejects(
			store(new MemoryBucket(), 'retry.sql', fetcher),
			backupError(code, retryable),
		)
	}

	const bucket = new MemoryBucket()
	await assert.rejects(
		store(bucket, 'empty.sql', async () => sized('', 0)),
		backupError('download-empty', true),
	)
	assert.equal(await bucket.head('empty.sql'), null)
	assert.equal(bucket.puts.length, 0)

	await assert.rejects(
		store(bucket, 'retry.sql', async () => {
			throw new Error('connection reset')
		}),
		backupError('download-interrupted', true),
	)
	assert.equal((await store(bucket, 'retry.sql')).bytes, 5)
})

test('existing objects still validate the signed source: mismatch, availability, size, and races', async () => {
	const bucket = new MemoryBucket()
	await store(bucket, 'backup.sql')
	await assert.rejects(
		store(bucket, 'backup.sql', 'other'),
		backupError('existing-object-source-mismatch', false),
	)
	const failures: Array<[typeof fetch, string]> = [
		[
			async () => {
				throw new Error('source unavailable')
			},
			'download-interrupted',
		],
		[async () => new Response('', { status: 403 }), 'download-http-error'],
		[async () => sized('abc', 5), 'download-truncated'],
		[tooLarge, 'download-too-large'],
	]
	for (const [fetcher, code] of failures) {
		await assert.rejects(
			store(bucket, 'backup.sql', fetcher),
			backupError(code),
		)
	}

	// A pre-existing object at the size limit cannot be resumed into a manifest.
	bucket.setReportedSize('backup.sql', MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES)
	await assert.rejects(
		store(bucket, 'backup.sql'),
		backupError('download-too-large'),
	)

	// Conditional-put races compare the winning object with the signed source.
	const raceBucket = new MemoryBucket()
	raceBucket.raceOnNextPut('backup.sql', 'other')
	await assert.rejects(
		store(raceBucket, 'backup.sql'),
		backupError('existing-object-source-mismatch'),
	)
	assert.equal(raceBucket.puts.length, 1)
})

test('manifest is immutable, schema-checked, and must match an existing source-matched object', async () => {
	const bucket = new MemoryBucket()
	const stored = await store(bucket, 'backup.sql')
	const template = manifest(stored)
	const first = {
		...template,
		payload: {
			...template.payload,
			sql: { ...template.payload.sql, objectKey: 'backup.sql' },
		},
	}
	await putImmutableManifest(r2(bucket), 'manifest.json', first)
	await putImmutableManifest(r2(bucket), 'manifest.json', first)
	await assert.rejects(
		putImmutableManifest(r2(bucket), 'manifest.json', {
			...first,
			payload: { ...first.payload, buildCommit: 'different' },
		}),
		backupError('manifest-conflict'),
	)
	assert.equal(
		(await readManifest(r2(bucket), 'manifest.json'))?.payload.buildCommit,
		'abc123',
	)

	const matchingDuplicate = await store(bucket, 'backup.sql')
	await assertDuplicateMatchesManifest(
		r2(bucket),
		'manifest.json',
		'backup.sql',
		matchingDuplicate,
	)
	await assert.rejects(
		assertDuplicateMatchesManifest(
			r2(bucket),
			'manifest.json',
			'other-backup.sql',
			matchingDuplicate,
		),
		backupError('duplicate-object-manifest-mismatch'),
	)

	await bucket.put('corrupt.json', JSON.stringify({ schemaVersion: 1 }))
	await assert.rejects(
		readManifest(r2(bucket), 'corrupt.json'),
		backupError('manifest-corrupt'),
	)
})
