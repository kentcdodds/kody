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
	insertJob(sqlite, { id: 'job-1', userId: 'user-aaa' })
	insertJob(sqlite, { id: 'job-2', userId: 'user-aaa' })
	insertJob(sqlite, { id: 'job-3', userId: 'user-bbb' })
	// A job that was deleted by retention and archived keeps its id here so a
	// leftover vector can still be swept; a still-live job that is also
	// archived must not be listed twice.
	insertArchivedArtifact(sqlite, {
		id: 'aja-1',
		jobId: 'job-archived',
		userId: 'user-aaa',
	})
	insertArchivedArtifact(sqlite, {
		id: 'aja-2',
		jobId: 'job-2',
		userId: 'user-aaa',
	})
	insertArchivedArtifact(sqlite, {
		id: 'aja-3',
		jobId: 'job-other-archived',
		userId: 'user-bbb',
	})

	const service = createService(db)
	await expect(
		service.listJobIdsForUser({ userId: 'user-aaa' }),
	).resolves.toEqual(['job-1', 'job-2', 'job-archived'])
	await expect(
		service.listJobIdsForUser({ userId: 'user-bbb' }),
	).resolves.toEqual(['job-3', 'job-other-archived'])
	await expect(
		service.listJobIdsForUser({ userId: 'user-none' }),
	).resolves.toEqual([])
})
