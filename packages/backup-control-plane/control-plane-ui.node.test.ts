import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { test, vi } from 'vitest'

import {
	MemoryBucket,
	badSqlStatsFixture,
	environment,
	identityEnvelope,
	manifest,
	putSqlStatsFixture,
	signedManifest,
} from './backup-control-plane-test-support.ts'
import { backupPayload, objectKeyForBookmark } from './backup-policy.ts'
import {
	collectDayStatuses,
	renderDashboard,
	renderRestoreStatusPage,
} from './control-plane-ui.ts'
import { putImmutableManifest } from './immutable-storage.ts'

test('dashboard renders oversized D1 SQL as not restorable with a warning', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const day = '2026-07-31'
	const payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const sql = 'CREATE TABLE t(id INTEGER);\n'
	const sqlObjectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const template = manifest({
		bytes: sql.length,
		sha256: createHash('sha256').update(sql).digest('hex'),
		r2Etag: createHash('md5').update(sql).digest('hex'),
	})
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

	const now = new Date(`${day}T12:00:00.000Z`)
	const [status] = await collectDayStatuses(env, now)
	assert.equal(status?.d1Restorable, false)
	assert.ok(
		status?.warnings.some((warning) => warning.includes('cannot be restored')),
	)

	const fetcher = vi.spyOn(globalThis, 'fetch')
	fetcher.mockResolvedValue(identityEnvelope(1_000))
	const html = await renderDashboard(env, { now })
	assert.match(html, /<th>D1 restorable<\/th>/)
	assert.match(html, /<td class="bad">no<\/td>/)
	assert.match(
		html,
		/D1 SQL contains oversized statements and cannot be restored/,
	)

	await bucket.delete(`${sqlObjectKey}.stats.json`)
	const [missingStatsStatus] = await collectDayStatuses(env, now)
	assert.equal(missingStatsStatus?.d1Restorable, false)
	const missingStatsHtml = await renderDashboard(env, { now })
	assert.match(missingStatsHtml, /<td class="bad">no<\/td>/)
	assert.match(
		missingStatsHtml,
		/D1 is not restorable: required SQL stats are missing/,
	)

	await putSqlStatsFixture(bucket, day, sqlObjectKey)
	bucket.failGetFor(`${sqlObjectKey}.stats.json`)
	const [statsReadFailure] = await collectDayStatuses(env, now)
	assert.equal(statsReadFailure?.d1Verified, true)
	assert.equal(statsReadFailure?.d1Restorable, false)
	assert.ok(
		statsReadFailure?.warnings.includes(
			'D1 is not restorable: SQL stats lookup failed',
		),
	)
	assert.equal(
		statsReadFailure?.warnings.includes('D1 manifest unreadable'),
		false,
	)
})

test('dashboard warns when a configured D1 source is missing and marks the day unrestorable', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const jobsId = '44444444-4444-4444-8444-444444444444'
	env.SOURCE_DATABASES = JSON.stringify([
		{ id: env.SOURCE_DATABASE_ID, name: env.SOURCE_DATABASE_NAME },
		{ id: jobsId, name: 'kody-jobs' },
	])
	env.ALLOWED_SOURCE_DATABASE_IDS = `${env.SOURCE_DATABASE_ID},${jobsId}`
	const day = '2026-07-31'
	const payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const sql = 'CREATE TABLE t(id INTEGER);\n'
	const sqlObjectKey = objectKeyForBookmark(payload.objectPrefix, 'bookmark-1')
	const template = manifest({
		bytes: sql.length,
		sha256: createHash('sha256').update(sql).digest('hex'),
		r2Etag: createHash('md5').update(sql).digest('hex'),
	})
	await bucket.put(sqlObjectKey, sql)
	await putSqlStatsFixture(bucket, day, sqlObjectKey)
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

	const now = new Date(`${day}T12:00:00.000Z`)
	const [status] = await collectDayStatuses(env, now)
	assert.equal(status?.d1Present, false)
	assert.equal(status?.d1Verified, false)
	assert.equal(status?.d1Restorable, false)
	assert.ok(
		status?.warnings.includes('kody-jobs: D1 manifest missing'),
		status?.warnings.join('; '),
	)

	const fetcher = vi.spyOn(globalThis, 'fetch')
	fetcher.mockResolvedValue(identityEnvelope(1_000))
	const html = await renderDashboard(env, { now })
	assert.match(html, /kody-jobs: D1 manifest missing/)
	assert.match(html, /<td class="bad">unverified<\/td>/)
	assert.match(html, /<td class="bad">no<\/td>/)
})

test('restore status lists undeclared databases as notes, not warnings', () => {
	const html = renderRestoreStatusPage({
		instanceId: 'dr-restore-2026-07-22-demo',
		status: 'complete',
		progress: {
			day: '2026-07-22',
			phase: 'complete',
			d1ImportComplete: true,
			storeRestoreComplete: true,
			storeIterations: 1,
			warnings: [],
			notes: ['JOBS_DB: not present in this backup day'],
		},
	})
	assert.match(html, /Not in this backup day/)
	assert.match(html, /JOBS_DB: not present in this backup day/)
	assert.doesNotMatch(html, /<span>Warnings<\/span>/)
})
