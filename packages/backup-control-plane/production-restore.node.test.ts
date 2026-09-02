import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { serializeBackupFullManifest } from '@kody-internal/shared/backup-full-manifest.ts'
import { sealedFullManifestKey } from '@kody-internal/shared/backup-staging.ts'
import { test, vi } from 'vitest'

import {
	ACCOUNT_ID,
	DATABASE_ID,
	MemoryBucket,
	badSqlStatsFixture,
	environment,
	exportEnvelope,
	manifest,
	signedManifest,
} from './backup-control-plane-test-support.ts'
import {
	BackupError,
	backupPayload,
	bindSourceDatabase,
	objectKeyForBookmark,
} from './backup-policy.ts'
import { d1ImportForeignKeysOffPrefix } from './d1-import-api.ts'
import { signBackupFullManifest } from './full-manifest-signing.ts'
import { putImmutableManifest } from './immutable-storage.ts'
import {
	runProductionRestore,
	restoreProgressFailsWorkflow,
} from './production-restore.ts'

function sha256Text(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}

async function seedSealedRestoreDay(bucket: MemoryBucket, day = '2026-07-22') {
	const env = environment(bucket)
	const d1Payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const sqlBody = 'CREATE TABLE t(id INTEGER);\n'
	const sqlMd5 = createHash('md5').update(sqlBody).digest('hex')
	const preparedImportMd5 = createHash('md5')
		.update(d1ImportForeignKeysOffPrefix)
		.update(sqlBody)
		.digest('hex')
	const template = manifest({
		bytes: sqlBody.length,
		sha256: sha256Text(sqlBody),
		r2Etag: sqlMd5,
	})
	const sqlObjectKey = template.payload.sql.objectKey.replace('2026-07-22', day)
	await bucket.put(sqlObjectKey, sqlBody)
	const dayManifest = signedManifest({
		...template.payload,
		sql: { ...template.payload.sql, objectKey: sqlObjectKey },
	})
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		d1Payload.manifestKey,
		dayManifest,
	)
	const stored = await bucket.get(d1Payload.manifestKey)
	const storedText = await stored!.text()
	const full = await signBackupFullManifest(env, {
		day,
		d1ManifestKey: d1Payload.manifestKey,
		d1ManifestSha256: sha256Text(storedText),
		mailboxIndex: {
			objectKey: `daily/full/${day}/mailbox-index.json`,
			bytes: 2,
			sha256: 'd'.repeat(64),
		},
		runLogIndex: {
			objectKey: `daily/full/${day}/run-log-index.json`,
			bytes: 2,
			sha256: 'e'.repeat(64),
		},
		storageIndex: {
			objectKey: `daily/full/${day}/storage-index.json`,
			bytes: 2,
			sha256: 'b'.repeat(64),
		},
		r2Indexes: {},
		artifactsIndex: {
			objectKey: `daily/full/${day}/artifacts-index.json`,
			bytes: 2,
			sha256: 'c'.repeat(64),
		},
		sealedAt: `${day}T04:00:00.000Z`,
		buildCommit: 'abc123',
	})
	await bucket.put(
		sealedFullManifestKey(day),
		serializeBackupFullManifest(full),
	)
	return { env, day, preparedImportMd5, sqlObjectKey }
}

test('runProductionRestore returns failed progress when dr-restore emits warnings', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day, preparedImportMd5 } = await seedSealedRestoreDay(bucket)
	let exportCalls = 0
	const sql = 'CREATE TABLE safety(id INTEGER);\n'
	const progress = await runProductionRestore(
		env,
		{ day, requestedAt: `${day}T12:00:00.000Z` },
		{
			now: new Date(`${day}T12:00:00.000Z`),
			sleep: async () => undefined,
			maxPollAttempts: 3,
			pollDelayMs: 1,
			fetcher: async (input, init) => {
				const url = String(input)
				if (url.includes('api.cloudflare.com') && url.includes('/export')) {
					exportCalls += 1
					return exportCalls === 1
						? exportEnvelope('active')
						: exportEnvelope('complete')
				}
				if (url.includes('download.example')) {
					return new Response(sql, {
						headers: { 'content-length': String(sql.length) },
					})
				}
				if (url.includes('/import')) {
					const body = JSON.parse(String(init?.body ?? '{}')) as {
						action?: string
					}
					if (body.action === 'init') {
						return Response.json({
							success: true,
							result: {
								upload_url: 'https://upload.example/sql',
								filename: 'import.sql',
							},
						})
					}
					if (body.action === 'ingest') {
						return Response.json({
							success: true,
							result: { at_bookmark: 'import-1', type: 'import' },
						})
					}
					return Response.json({
						success: true,
						result: { status: 'complete', success: true, type: 'import' },
					})
				}
				if (url.includes('upload.example')) {
					return new Response(null, {
						status: 200,
						headers: { etag: `"${preparedImportMd5}"` },
					})
				}
				if (url.includes('/__maintenance/dr-restore')) {
					return Response.json({
						done: true,
						progress: { step: 'done' },
						warnings: ['storage-partial', 'blob-skipped'],
					})
				}
				throw new Error(`unexpected fetch ${url}`)
			},
		},
	)
	assert.equal(progress.phase, 'failed')
	assert.equal(progress.errorCode, 'dr-restore-warnings')
	assert.deepEqual(progress.warnings, ['storage-partial', 'blob-skipped'])
	assert.equal(progress.storeRestoreComplete, true)
	assert.equal(progress.d1ImportComplete, true)
	assert.equal(exportCalls, 2)
	const safetyExportKey = progress.safetyExportKey
	assert.equal(
		safetyExportKey,
		`pre-restore/${day}/${DATABASE_ID}/${day}T12:00:00.000Z.sql`,
	)
	assert.equal(progress.safetyExportBytes, sql.length)
	assert.ok(safetyExportKey)
	assert.ok(await bucket.head(safetyExportKey))
})

test('production restore refuses SQL with oversized statement stats', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day, sqlObjectKey } = await seedSealedRestoreDay(
		bucket,
		'2026-07-31',
	)
	await bucket.put(
		`${sqlObjectKey}.stats.json`,
		JSON.stringify(badSqlStatsFixture(day, sqlObjectKey)),
	)

	let fetchCalls = 0
	await assert.rejects(
		runProductionRestore(
			env,
			{ day, requestedAt: `${day}T12:00:00.000Z` },
			{
				fetcher: async () => {
					fetchCalls += 1
					throw new Error('restore should not start')
				},
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'backup-unrestorable-statements',
	)
	assert.equal(fetchCalls, 0)
})

const JOBS_DATABASE_ID = '44444444-4444-4444-8444-444444444444'

function configureJobsDatabase(
	env: ReturnType<typeof environment>,
): ReturnType<typeof environment> {
	env.SOURCE_DATABASES = JSON.stringify([
		{ id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME },
		{ id: JOBS_DATABASE_ID, name: 'kody-jobs' },
	])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${env.SOURCE_DATABASE_ID},${JOBS_DATABASE_ID}`
	return env
}

async function putJobsRestoreManifest(
	bucket: MemoryBucket,
	env: ReturnType<typeof environment>,
	day: string,
	options: { putSql?: boolean } = {},
) {
	const jobsEnv = bindSourceDatabase(env, {
		id: JOBS_DATABASE_ID,
		name: 'kody-jobs',
	})
	const jobsPayload = backupPayload(jobsEnv, new Date(`${day}T12:00:00.000Z`))
	const sqlBody = 'CREATE TABLE jobs(id INTEGER);\n'
	const sqlObjectKey = objectKeyForBookmark(
		jobsPayload.objectPrefix,
		'bookmark-1',
	)
	if (options.putSql !== false) {
		await bucket.put(sqlObjectKey, sqlBody)
	}
	const dayManifest = signedManifest({
		...manifest({
			bytes: sqlBody.length,
			sha256: sha256Text(sqlBody),
			r2Etag: createHash('md5').update(sqlBody).digest('hex'),
		}).payload,
		source: {
			accountId: ACCOUNT_ID,
			databaseId: JOBS_DATABASE_ID,
			databaseName: 'kody-jobs',
		},
		sql: {
			objectKey: sqlObjectKey,
			bytes: sqlBody.length,
			sha256: sha256Text(sqlBody),
			r2Etag: createHash('md5').update(sqlBody).digest('hex'),
		},
	})
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		jobsPayload.manifestKey,
		dayManifest,
	)
	const stored = await bucket.get(jobsPayload.manifestKey)
	return {
		manifestKey: jobsPayload.manifestKey,
		sqlObjectKey,
		storedText: await stored!.text(),
	}
}

function trackSqlObjectAccess(
	bucket: MemoryBucket,
	sqlObjectKeys: Array<string>,
): { heads: Array<string>; gets: Array<string> } {
	const tracked = new Set(sqlObjectKeys)
	const heads: Array<string> = []
	const gets: Array<string> = []
	const originalHead = bucket.head.bind(bucket)
	const originalGet = bucket.get.bind(bucket)
	bucket.head = async (key: string) => {
		if (tracked.has(key)) heads.push(key)
		return originalHead(key)
	}
	bucket.get = async (key: string) => {
		if (tracked.has(key)) gets.push(key)
		return originalGet(key)
	}
	return { heads, gets }
}

test('production restore of a historical single-database day completes the workflow without failure', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day, preparedImportMd5, sqlObjectKey } =
		await seedSealedRestoreDay(bucket)
	configureJobsDatabase(env)
	const sqlAccess = trackSqlObjectAccess(bucket, [sqlObjectKey])
	let exportCalls = 0
	const importedDatabaseIds: Array<string> = []
	const sql = 'CREATE TABLE safety(id INTEGER);\n'
	const progress = await runProductionRestore(
		env,
		{ day, requestedAt: `${day}T12:00:00.000Z` },
		{
			now: new Date(`${day}T12:00:00.000Z`),
			sleep: async () => undefined,
			maxPollAttempts: 3,
			pollDelayMs: 1,
			fetcher: async (input, init) => {
				const url = String(input)
				if (url.includes('api.cloudflare.com') && url.includes('/export')) {
					exportCalls += 1
					return exportCalls === 1
						? exportEnvelope('active')
						: exportEnvelope('complete')
				}
				if (url.includes('download.example')) {
					return new Response(sql, {
						headers: { 'content-length': String(sql.length) },
					})
				}
				if (url.includes('/import')) {
					const body = JSON.parse(String(init?.body ?? '{}')) as {
						action?: string
					}
					if (body.action === 'init') {
						const match = /\/d1\/database\/([^/]+)\/import/.exec(url)
						if (match?.[1]) importedDatabaseIds.push(match[1])
						return Response.json({
							success: true,
							result: {
								upload_url: 'https://upload.example/sql',
								filename: 'import.sql',
							},
						})
					}
					if (body.action === 'ingest') {
						return Response.json({
							success: true,
							result: { at_bookmark: 'import-1', type: 'import' },
						})
					}
					return Response.json({
						success: true,
						result: { status: 'complete', success: true, type: 'import' },
					})
				}
				if (url.includes('upload.example')) {
					return new Response(null, {
						status: 200,
						headers: { etag: `"${preparedImportMd5}"` },
					})
				}
				if (url.includes('/__maintenance/dr-restore')) {
					return Response.json({
						done: true,
						progress: { step: 'done' },
						warnings: [],
					})
				}
				throw new Error(`unexpected fetch ${url}`)
			},
		},
	)
	assert.equal(progress.phase, 'complete')
	assert.deepEqual(importedDatabaseIds, [DATABASE_ID])
	assert.equal(exportCalls, 2)
	assert.deepEqual(progress.warnings, [])
	assert.deepEqual(progress.notes, ['JOBS_DB: not present in this backup day'])
	assert.equal(restoreProgressFailsWorkflow(progress), false)
	assert.equal(progress.safetyExports?.length, 1)
	assert.equal(progress.safetyExports?.[0]?.databaseId, DATABASE_ID)
	assert.deepEqual(sqlAccess.heads, [sqlObjectKey])
	assert.deepEqual(sqlAccess.gets, [sqlObjectKey, sqlObjectKey, sqlObjectKey])
})

test('production restore verifies every required SQL object before importing APP_DB', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockImplementation(() => undefined)
	const bucket = new MemoryBucket()
	const { env, day, sqlObjectKey } = await seedSealedRestoreDay(bucket)
	configureJobsDatabase(env)
	const jobs = await putJobsRestoreManifest(bucket, env, day, { putSql: false })
	const appManifestKey = backupPayload(
		env,
		new Date(`${day}T12:00:00.000Z`),
	).manifestKey
	const appManifestObject = await bucket.get(appManifestKey)
	const appStoredText = await appManifestObject!.text()
	const appManifestSha256 = sha256Text(appStoredText)
	const full = await signBackupFullManifest(env, {
		day,
		d1ManifestKey: appManifestKey,
		d1ManifestSha256: appManifestSha256,
		d1Sources: [
			{
				databaseId: DATABASE_ID,
				databaseName: env.SOURCE_DATABASE_NAME,
				manifestKey: appManifestKey,
				manifestSha256: appManifestSha256,
			},
			{
				databaseId: JOBS_DATABASE_ID,
				databaseName: 'kody-jobs',
				manifestKey: jobs.manifestKey,
				manifestSha256: sha256Text(jobs.storedText),
			},
		],
		mailboxIndex: {
			objectKey: `daily/full/${day}/mailbox-index.json`,
			bytes: 2,
			sha256: 'd'.repeat(64),
		},
		runLogIndex: {
			objectKey: `daily/full/${day}/run-log-index.json`,
			bytes: 2,
			sha256: 'e'.repeat(64),
		},
		storageIndex: {
			objectKey: `daily/full/${day}/storage-index.json`,
			bytes: 2,
			sha256: 'b'.repeat(64),
		},
		r2Indexes: {},
		artifactsIndex: {
			objectKey: `daily/full/${day}/artifacts-index.json`,
			bytes: 2,
			sha256: 'c'.repeat(64),
		},
		sealedAt: `${day}T04:00:00.000Z`,
		buildCommit: 'abc123',
	})
	await bucket.put(
		sealedFullManifestKey(day),
		serializeBackupFullManifest(full),
	)

	const sqlAccess = trackSqlObjectAccess(bucket, [
		sqlObjectKey,
		jobs.sqlObjectKey,
	])
	let fetchCalls = 0
	let importedAppDb = false
	await assert.rejects(
		runProductionRestore(
			env,
			{ day, requestedAt: `${day}T12:00:00.000Z` },
			{
				fetcher: async (input) => {
					fetchCalls += 1
					const url = String(input)
					if (url.includes(`/d1/database/${DATABASE_ID}/import`)) {
						importedAppDb = true
					}
					throw new Error('restore should not start')
				},
			},
		),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'restore-sql-missing' &&
			error.message.includes(jobs.sqlObjectKey) &&
			error.message.includes('kody-jobs'),
	)
	assert.equal(fetchCalls, 0)
	assert.equal(importedAppDb, false)
	assert.deepEqual(sqlAccess.heads, [sqlObjectKey, jobs.sqlObjectKey])
	assert.deepEqual(sqlAccess.gets, [])
})
