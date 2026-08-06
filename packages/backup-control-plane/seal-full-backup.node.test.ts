import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
	backupBlobKey,
	backupStagingSchemaVersion,
	sealedFullManifestKey,
	stagingArtifactsIndexKey,
	stagingMailboxDumpKey,
	stagingMailboxIndexKey,
	stagingR2IndexKey,
	stagingRunLogDumpKey,
	stagingRunLogIndexKey,
	stagingStorageDumpKey,
	stagingStorageIndexKey,
	stagingSummaryKey,
} from '@kody-internal/shared/backup-staging.ts'
import { test, vi } from 'vitest'

import {
	MemoryBucket,
	badSqlStatsFixture,
	environment,
	manifest,
	putSqlStatsFixture,
	signedManifest,
} from './backup-control-plane-test-support.ts'
import { BackupError, backupPayload } from './backup-policy.ts'
import { putImmutableManifest } from './immutable-storage.ts'
import { readFullManifest, sealFullBackupDay } from './seal-full-backup.ts'

function sha256Text(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

async function seedCompleteDay(
	bucket: MemoryBucket,
	day = '2026-07-22',
	options: { duplicateIndexEntry?: boolean } = {},
) {
	const env = environment(bucket)
	const d1Payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const sqlBody = 'CREATE TABLE t(id INTEGER);\n'
	const template = manifest({
		bytes: sqlBody.length,
		sha256: sha256Text(sqlBody),
		r2Etag: createHash('md5').update(sqlBody).digest('hex'),
	})
	const sqlKey = template.payload.sql.objectKey
	await bucket.put(sqlKey, sqlBody)
	const dayManifest = signedManifest({
		...template.payload,
		export: {
			bookmark: 'bookmark-1',
			scheduledAt: `${day}T02:15:00.000Z`,
			startedAt: `${day}T02:15:01.000Z`,
			completedAt: `${day}T02:16:00.000Z`,
		},
		sql: {
			...template.payload.sql,
			objectKey: sqlKey,
		},
	})
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		d1Payload.manifestKey,
		dayManifest,
	)

	const dumpKey = stagingStorageDumpKey(day, 'user-storage-1')
	const dumpBody = '{"key":"a","valueJson":"1"}\n'
	const indexEntry = {
		storageId: 'user-storage-1',
		objectKey: dumpKey,
		entryCount: 1,
		bytes: dumpBody.length,
		sha256: sha256Text(dumpBody),
	}
	const storageIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: options.duplicateIndexEntry
			? [indexEntry, indexEntry]
			: [indexEntry],
	})
	const ownerId = 'user-owner-1'
	const mailboxDumpKey = stagingMailboxDumpKey(day, ownerId)
	const mailboxDumpBody = '{"kind":"thread","row":{"id":"thread-1"}}\n'
	const mailboxIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: [
			{
				ownerId,
				objectKey: mailboxDumpKey,
				entryCount: 1,
				bytes: mailboxDumpBody.length,
				sha256: sha256Text(mailboxDumpBody),
			},
		],
	})
	const runLogDumpKey = stagingRunLogDumpKey(day, ownerId)
	const runLogDumpBody =
		'{"kind":"activationMilestone","row":{"milestone":"package_activated"}}\n'
	const runLogIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: [
			{
				ownerId,
				objectKey: runLogDumpKey,
				entryCount: 1,
				bytes: runLogDumpBody.length,
				sha256: sha256Text(runLogDumpBody),
			},
		],
	})
	const blobHash = 'e'.repeat(64)
	const r2IndexBody = `{"key":"blob","size":1,"sha256":"${blobHash}"}\n`
	const artifactsBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day,
		entries: [],
	})
	const storageIndexKey = stagingStorageIndexKey(day)
	const r2IndexKey = stagingR2IndexKey(day, 'email-blobs')
	const artifactsKey = stagingArtifactsIndexKey(day)
	const mailboxIndexKey = stagingMailboxIndexKey(day)
	const runLogIndexKey = stagingRunLogIndexKey(day)
	await bucket.put(dumpKey, dumpBody)
	await bucket.put(mailboxDumpKey, mailboxDumpBody)
	await bucket.put(mailboxIndexKey, mailboxIndexBody)
	await bucket.put(runLogDumpKey, runLogDumpBody)
	await bucket.put(runLogIndexKey, runLogIndexBody)
	await bucket.put(storageIndexKey, storageIndexBody)
	await bucket.put(r2IndexKey, r2IndexBody)
	await bucket.put(artifactsKey, artifactsBody)
	await bucket.put(backupBlobKey(blobHash), 'x')
	const summary = {
		schemaVersion: backupStagingSchemaVersion,
		day,
		startedAt: `${day}T03:00:00.000Z`,
		completedAt: `${day}T03:05:00.000Z`,
		buildCommit: 'abc123',
		mailboxIndex: {
			objectKey: mailboxIndexKey,
			bytes: mailboxIndexBody.length,
			sha256: sha256Text(mailboxIndexBody),
		},
		runLogIndex: {
			objectKey: runLogIndexKey,
			bytes: runLogIndexBody.length,
			sha256: sha256Text(runLogIndexBody),
		},
		storageIndex: {
			objectKey: storageIndexKey,
			bytes: storageIndexBody.length,
			sha256: sha256Text(storageIndexBody),
		},
		r2Indexes: {
			'email-blobs': {
				objectKey: r2IndexKey,
				bytes: r2IndexBody.length,
				sha256: sha256Text(r2IndexBody),
			},
		},
		artifactsIndex: {
			objectKey: artifactsKey,
			bytes: artifactsBody.length,
			sha256: sha256Text(artifactsBody),
		},
		blobsWritten: 1,
		blobsReused: 0,
		warnings: [],
	}
	await bucket.put(stagingSummaryKey(day), JSON.stringify(summary))
	return { env, day, sqlKey }
}

test('sealFullBackupDay seals a complete day and is idempotent', async () => {
	const bucket = new MemoryBucket()
	const { env, day } = await seedCompleteDay(bucket)
	const first = await sealFullBackupDay(
		env,
		day,
		new Date(`${day}T04:00:00.000Z`),
	)
	assert.equal(first.kind, 'sealed')
	if (first.kind !== 'sealed') return
	assert.equal(first.alreadySealed, false)
	const sealed = await readFullManifest(
		bucket as unknown as R2Bucket,
		sealedFullManifestKey(day),
	)
	assert.ok(sealed)
	assert.equal(sealed?.payload.day, day)
	assert.equal(
		sealed?.payload.schemaVersion === 2
			? sealed.payload.mailboxIndex.objectKey
			: null,
		`daily/full/${day}/mailbox-index.json`,
	)
	assert.ok(
		await bucket.head(
			`daily/full/${day}/mailbox/${encodeURIComponent('user-owner-1')}.ndjson`,
		),
	)

	const second = await sealFullBackupDay(
		env,
		day,
		new Date(`${day}T04:01:00.000Z`),
	)
	assert.equal(second.kind, 'sealed')
	if (second.kind !== 'sealed') return
	assert.equal(second.alreadySealed, true)
})

test('sealFullBackupDay completes over locked partial state and duplicate index entries', async () => {
	// Reproduces the 2026-07-28 production wedge: the bucket-lock rule
	// rejects puts on existing keys with error 10069, the storage index
	// contained duplicate entries from mid-window inventory drift, and a
	// partial earlier attempt had already copied some sealed objects. The
	// seal must fall through to byte comparison in all three situations.
	const bucket = new MemoryBucket()
	bucket.enableLockPolicy()
	const { env, day } = await seedCompleteDay(bucket, '2026-07-22', {
		duplicateIndexEntry: true,
	})
	// Simulate the partial earlier attempt: the dump is already sealed.
	const dumpBody = '{"key":"a","valueJson":"1"}\n'
	await bucket.put(
		`daily/full/${day}/storage/${encodeURIComponent('user-storage-1')}.ndjson`,
		dumpBody,
	)

	const result = await sealFullBackupDay(
		env,
		day,
		new Date(`${day}T04:00:00.000Z`),
	)
	assert.equal(result.kind, 'sealed')
	if (result.kind !== 'sealed') return
	assert.equal(result.alreadySealed, false)
	const sealed = await readFullManifest(
		bucket as unknown as R2Bucket,
		sealedFullManifestKey(day),
	)
	assert.equal(sealed?.payload.day, day)
})

test('sealFullBackupDay fails closed on staging storage or mailbox sha mismatches', async () => {
	const storageBucket = new MemoryBucket()
	const storageDay = await seedCompleteDay(storageBucket)
	await storageBucket.put(
		stagingStorageIndexKey(storageDay.day),
		'{"tampered":true}',
	)
	await assert.rejects(
		sealFullBackupDay(
			storageDay.env,
			storageDay.day,
			new Date(`${storageDay.day}T04:00:00.000Z`),
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'staging-sha-mismatch',
	)
	assert.equal(
		await storageBucket.head(sealedFullManifestKey(storageDay.day)),
		null,
	)

	const mailboxBucket = new MemoryBucket()
	const mailboxDay = await seedCompleteDay(mailboxBucket)
	await mailboxBucket.put(
		stagingMailboxDumpKey(mailboxDay.day, 'user-owner-1'),
		'{"tampered":true}\n',
	)
	await assert.rejects(
		sealFullBackupDay(
			mailboxDay.env,
			mailboxDay.day,
			new Date(`${mailboxDay.day}T04:00:00.000Z`),
		),
		(error: unknown) =>
			error instanceof BackupError && error.code === 'staging-sha-mismatch',
	)
	assert.equal(
		await mailboxBucket.head(sealedFullManifestKey(mailboxDay.day)),
		null,
	)
})

test('sealFullBackupDay refuses missing or unrestorable SQL stats before sealing', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)

	const missingBucket = new MemoryBucket()
	const missing = await seedCompleteDay(missingBucket, '2026-07-31')
	assert.deepEqual(
		await sealFullBackupDay(
			missing.env,
			missing.day,
			new Date(`${missing.day}T04:00:00.000Z`),
		),
		{
			kind: 'incomplete',
			day: missing.day,
			reason: 'backup-sql-stats-missing',
		},
	)
	assert.equal(
		await missingBucket.head(sealedFullManifestKey(missing.day)),
		null,
	)
	const missingRecord = JSON.parse(
		String(consoleError.mock.calls.at(-1)?.[0]),
	) as Record<string, unknown>
	assert.equal(missingRecord.event, 'full-backup-seal-skipped')
	assert.equal(missingRecord.errorCode, 'backup-sql-stats-missing')

	const oversizedBucket = new MemoryBucket()
	const oversized = await seedCompleteDay(oversizedBucket, '2026-07-31')
	await oversizedBucket.put(
		`${oversized.sqlKey}.stats.json`,
		JSON.stringify(badSqlStatsFixture(oversized.day, oversized.sqlKey)),
	)
	assert.deepEqual(
		await sealFullBackupDay(
			oversized.env,
			oversized.day,
			new Date(`${oversized.day}T04:00:00.000Z`),
		),
		{
			kind: 'incomplete',
			day: oversized.day,
			reason: 'backup-unrestorable-statements',
		},
	)
	assert.equal(
		await oversizedBucket.head(sealedFullManifestKey(oversized.day)),
		null,
	)
	const oversizedRecord = JSON.parse(
		String(consoleError.mock.calls.at(-1)?.[0]),
	) as Record<string, unknown>
	assert.equal(oversizedRecord.event, 'full-backup-seal-skipped')
	assert.equal(oversizedRecord.errorCode, 'backup-unrestorable-statements')

	const sealedBucket = new MemoryBucket()
	const sealedDay = await seedCompleteDay(sealedBucket, '2026-07-31')
	await putSqlStatsFixture(sealedBucket, sealedDay.day, sealedDay.sqlKey)
	const sealed = await sealFullBackupDay(
		sealedDay.env,
		sealedDay.day,
		new Date(`${sealedDay.day}T04:00:00.000Z`),
	)
	assert.equal(sealed.kind, 'sealed')
	await sealedBucket.put(
		`${sealedDay.sqlKey}.stats.json`,
		JSON.stringify(badSqlStatsFixture(sealedDay.day, sealedDay.sqlKey)),
	)
	assert.deepEqual(
		await sealFullBackupDay(
			sealedDay.env,
			sealedDay.day,
			new Date(`${sealedDay.day}T04:01:00.000Z`),
		),
		{
			kind: 'incomplete',
			day: sealedDay.day,
			reason: 'backup-unrestorable-statements',
		},
	)
})

test('sealFullBackupDay is incomplete when the 501st referenced blob is missing', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day } = await seedCompleteDay(bucket)
	const lines: Array<string> = []
	for (let index = 0; index < 501; index += 1) {
		const hash = index.toString(16).padStart(64, '0')
		lines.push(
			JSON.stringify({ key: `blob-${String(index)}`, size: 1, sha256: hash }),
		)
		if (index < 500) {
			await bucket.put(backupBlobKey(hash), 'x')
		}
		// Intentionally omit blob 500 so verification past the old sample cap fails.
	}
	const r2IndexBody = `${lines.join('\n')}\n`
	const r2IndexKey = stagingR2IndexKey(day, 'email-blobs')
	await bucket.put(r2IndexKey, r2IndexBody)
	const summaryObject = await bucket.get(stagingSummaryKey(day))
	const summary = (await summaryObject!.json()) as {
		r2Indexes: {
			'email-blobs': { objectKey: string; bytes: number; sha256: string }
		}
		[key: string]: unknown
	}
	summary.r2Indexes['email-blobs'] = {
		objectKey: r2IndexKey,
		bytes: r2IndexBody.length,
		sha256: sha256Text(r2IndexBody),
	}
	await bucket.put(stagingSummaryKey(day), JSON.stringify(summary))
	const result = await sealFullBackupDay(
		env,
		day,
		new Date(`${day}T04:00:00.000Z`),
	)
	assert.deepEqual(result, {
		kind: 'incomplete',
		day,
		reason: 'blob-missing',
	})
	assert.equal(await bucket.head(sealedFullManifestKey(day)), null)
})
