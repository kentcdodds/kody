import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { serializeBackupFullManifest } from '@kody-internal/shared/backup-full-manifest.ts'
import { sealedFullManifestKey } from '@kody-internal/shared/backup-staging.ts'
import { test, vi } from 'vitest'

import {
	MemoryBucket,
	environment,
	exportEnvelope,
	manifest,
	signedManifest,
} from './backup-control-plane-test-support.ts'
import { backupPayload } from './backup-policy.ts'
import { d1ImportForeignKeysOffPrefix } from './d1-import-api.ts'
import { signBackupFullManifest } from './full-manifest-signing.ts'
import { putImmutableManifest } from './immutable-storage.ts'
import { runProductionRestore } from './production-restore.ts'

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
	await bucket.put(template.payload.sql.objectKey, sqlBody)
	const dayManifest = signedManifest({
		...template.payload,
		sql: template.payload.sql,
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
	return { env, day, preparedImportMd5 }
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
	assert.equal(safetyExportKey, `pre-restore/${day}/${day}T12:00:00.000Z.sql`)
	assert.equal(progress.safetyExportBytes, sql.length)
	assert.ok(safetyExportKey)
	assert.ok(await bucket.head(safetyExportKey))
})
