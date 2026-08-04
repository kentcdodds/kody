import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test } from 'vitest'

import {
	ACCOUNT_ID,
	MemoryBucket,
	badSqlStatsFixture,
	environment,
	manifest,
	signedManifest,
} from './backup-control-plane-test-support.ts'
import { BackupError, backupPayload } from './backup-policy.ts'
import { putImmutableManifest } from './immutable-storage.ts'
import { assertDrillAccountIsolated, runRestoreDrill } from './restore-drill.ts'

test('restore drill refuses same account and accepts an isolated account', () => {
	const env = environment()
	env.DRILL_ACCOUNT_ID = ACCOUNT_ID
	assert.throws(
		() => assertDrillAccountIsolated(env),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'drill-account-not-isolated',
	)
	assert.doesNotThrow(() => assertDrillAccountIsolated(environment()))
})

test('restore drill refuses SQL with oversized statement stats before import', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const day = '2026-07-31'
	const payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const sql = 'CREATE TABLE t(id INTEGER);\n'
	const template = manifest({
		bytes: sql.length,
		sha256: createHash('sha256').update(sql).digest('hex'),
		r2Etag: createHash('md5').update(sql).digest('hex'),
	})
	const sqlObjectKey = template.payload.sql.objectKey.replace('2026-07-22', day)
	await bucket.put(sqlObjectKey, sql)
	await bucket.put(
		`${sqlObjectKey}.stats.json`,
		JSON.stringify(badSqlStatsFixture(day, sqlObjectKey)),
	)
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		payload.manifestKey,
		signedManifest({
			...template.payload,
			export: {
				...template.payload.export,
				scheduledAt: `${day}T02:15:00.000Z`,
				startedAt: `${day}T02:15:01.000Z`,
				completedAt: `${day}T02:16:00.000Z`,
			},
			sql: { ...template.payload.sql, objectKey: sqlObjectKey },
		}),
	)

	let fetchCalls = 0
	await assert.rejects(
		runRestoreDrill(env, day, {
			fetcher: async () => {
				fetchCalls += 1
				throw new Error('import should not start')
			},
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'backup-unrestorable-statements',
	)
	assert.equal(fetchCalls, 0)
})
