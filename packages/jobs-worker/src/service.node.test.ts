import { createD1JobsStore } from '@kody-internal/shared/jobs/store.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type JobsWorkerEnv } from './env.ts'
import { JobsService } from './service.ts'

function createJobsDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertJob(
	sqlite: DatabaseSync,
	input: { id: string; userId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO jobs (
				id, user_id, name, source_id, storage_id, schedule_json, timezone,
				caller_context_json, created_at, updated_at, next_run_at
			) VALUES (?, ?, ?, 'src-1', ?, '{}', 'UTC', '{}', ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			`name-${input.id}`,
			`job:${input.id}`,
			'2026-09-01T00:00:00.000Z',
			'2026-09-01T00:00:00.000Z',
			'2026-09-02T00:00:00.000Z',
		)
}

function insertArchivedArtifact(
	sqlite: DatabaseSync,
	input: { id: string; jobId: string; userId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO archived_job_artifacts (
				id, job_id, user_id, source_id, published_commit, storage_id,
				retain_until, created_at, updated_at
			) VALUES (?, ?, ?, 'src-1', 'abc123', ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.jobId,
			input.userId,
			`job:${input.jobId}`,
			'2026-10-01T00:00:00.000Z',
			'2026-09-01T00:00:00.000Z',
			'2026-09-01T00:00:00.000Z',
		)
}

function createService(db: D1Database) {
	const env = { JOBS_DB: db } as unknown as JobsWorkerEnv
	return new JobsService({ props: {} } as never, env)
}

test('listJobIdsForUser returns the user’s live and archived job ids from the jobs D1 only', async () => {
	const { sqlite, db } = createJobsDb()
	for (const [id, userId] of [
		['job-1', 'user-aaa'],
		['job-2', 'user-aaa'],
		['job-3', 'user-bbb'],
	] as const) {
		insertJob(sqlite, { id, userId })
	}
	// A job that was deleted by retention and archived keeps its id here so a
	// leftover vector can still be swept; a still-live job that is also
	// archived must not be listed twice.
	for (const [id, jobId, userId] of [
		['aja-1', 'job-archived', 'user-aaa'],
		['aja-2', 'job-2', 'user-aaa'],
		['aja-3', 'job-other-archived', 'user-bbb'],
	] as const) {
		insertArchivedArtifact(sqlite, { id, jobId, userId })
	}

	const service = createService(db)
	for (const [userId, jobIds] of [
		['user-aaa', ['job-1', 'job-2', 'job-archived']],
		['user-bbb', ['job-3', 'job-other-archived']],
		['user-none', []],
	] as const) {
		await expect(service.listJobIdsForUser({ userId })).resolves.toEqual(jobIds)
	}
})

test('soft-delete records each job enabled flag and restore puts it back', async () => {
	const { sqlite, db } = createJobsDb()
	insertJob(sqlite, { id: 'job-on', userId: 'org-jobs' })
	insertJob(sqlite, { id: 'job-off', userId: 'org-jobs' })
	sqlite.prepare(`UPDATE jobs SET enabled = 0 WHERE id = 'job-off'`).run()
	const store = createD1JobsStore(db)
	const deletedAt = '2026-10-01T12:00:00.000Z'
	expect(
		await store.softDeleteJobsForUser({ userId: 'org-jobs', deletedAt }),
	).toBe(2)
	const tombstoned = sqlite
		.prepare(
			`SELECT id, enabled, enabled_before_soft_delete AS before
			 FROM jobs WHERE user_id = 'org-jobs' ORDER BY id`,
		)
		.all() as Array<{ id: string; enabled: number; before: number }>
	expect(tombstoned).toEqual([
		{ id: 'job-off', enabled: 0, before: 0 },
		{ id: 'job-on', enabled: 0, before: 1 },
	])
	expect(
		await store.softDeleteJobsForUser({
			userId: 'org-jobs',
			deletedAt: '2026-10-02T00:00:00.000Z',
		}),
	).toBe(0)
	const stillOriginal = sqlite
		.prepare(
			`SELECT deleted_at, enabled_before_soft_delete AS before
			 FROM jobs WHERE id = 'job-on'`,
		)
		.get() as { deleted_at: string; before: number }
	expect(stillOriginal).toEqual({ deleted_at: deletedAt, before: 1 })
	const candidates = await store.listJobRetentionCandidates({
		afterId: null,
		limit: 20,
	})
	expect(candidates.map((row) => row.id)).not.toContain('job-on')
	expect(
		await store.restoreJobsForUser({
			userId: 'org-jobs',
			deletedAt,
			restoredAt: '2026-10-03T00:00:00.000Z',
		}),
	).toBe(2)
	const restored = sqlite
		.prepare(
			`SELECT id, enabled, enabled_before_soft_delete AS before, deleted_at
			 FROM jobs WHERE user_id = 'org-jobs' ORDER BY id`,
		)
		.all() as Array<{
		id: string
		enabled: number
		before: number | null
		deleted_at: string | null
	}>
	expect(restored).toEqual([
		{ id: 'job-off', enabled: 0, before: null, deleted_at: null },
		{ id: 'job-on', enabled: 1, before: null, deleted_at: null },
	])
})

test('restore leaves a pre-column tombstone disabled', async () => {
	const { sqlite, db } = createJobsDb()
	insertJob(sqlite, { id: 'job-legacy', userId: 'org-legacy' })
	const deletedAt = '2026-09-01T00:00:00.000Z'
	sqlite
		.prepare(
			`UPDATE jobs
			 SET deleted_at = ?, enabled = 0, enabled_before_soft_delete = NULL
			 WHERE id = 'job-legacy'`,
		)
		.run(deletedAt)
	const store = createD1JobsStore(db)
	expect(
		await store.restoreJobsForUser({
			userId: 'org-legacy',
			deletedAt,
			restoredAt: '2026-09-02T00:00:00.000Z',
		}),
	).toBe(1)
	const row = sqlite
		.prepare(`SELECT enabled, deleted_at FROM jobs WHERE id = 'job-legacy'`)
		.get() as { enabled: number; deleted_at: string | null }
	expect(row).toEqual({ enabled: 0, deleted_at: null })
})
