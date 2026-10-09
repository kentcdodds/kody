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
