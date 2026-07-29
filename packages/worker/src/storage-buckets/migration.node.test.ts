import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const userStorageBucketsMigration = '0097-user-storage-buckets.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function applyMigration(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

test('user_storage_buckets migration backfills jobs, apps, and archived job buckets', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, userStorageBucketsMigration)

	db.exec(`
		INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			caller_context_json, created_at, updated_at, next_run_at
		) VALUES (
			'job-1', 'user-a', 'nightly', 'source-job-1', 'job:job-1', '{}', 'UTC',
			'{}', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z',
			'2026-07-03T00:00:00.000Z'
		);

		INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, has_app,
			created_at, updated_at
		) VALUES (
			'pkg-app-1', 'user-a', '@a/app', 'app', 'App package', 'source-app-1', 1,
			'2026-07-04T00:00:00.000Z', '2026-07-05T00:00:00.000Z'
		);

		INSERT INTO archived_job_artifacts (
			id, job_id, user_id, source_id, published_commit, storage_id,
			retain_until, created_at, updated_at
		) VALUES (
			'archived-1', 'job-deleted', 'user-a', 'source-job-2', 'abc123',
			'job:job-deleted', '2026-09-01T00:00:00.000Z',
			'2026-07-07T00:00:00.000Z', '2026-07-08T00:00:00.000Z'
		);

	`)

	applyMigration(db, userStorageBucketsMigration)

	const rows = db
		.prepare(
			`SELECT user_id, storage_id, kind, created_at, last_seen_at
			FROM user_storage_buckets
			ORDER BY storage_id ASC`,
		)
		.all() as Array<{
		user_id: string
		storage_id: string
		kind: string
		created_at: string
		last_seen_at: string
	}>

	expect(rows).toEqual([
		{
			user_id: 'user-a',
			storage_id: 'job:job-1',
			kind: 'job',
			created_at: '2026-07-01T00:00:00.000Z',
			last_seen_at: '2026-07-02T00:00:00.000Z',
		},
		{
			user_id: 'user-a',
			storage_id: 'job:job-deleted',
			kind: 'job',
			created_at: '2026-07-07T00:00:00.000Z',
			last_seen_at: '2026-07-08T00:00:00.000Z',
		},
		{
			user_id: 'user-a',
			storage_id: 'pkg-app-1',
			kind: 'app',
			created_at: '2026-07-04T00:00:00.000Z',
			last_seen_at: '2026-07-05T00:00:00.000Z',
		},
	])
})

test('user_storage_buckets package-kind migration reclassifies package and service buckets', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, '0108-user-storage-buckets-package-kind.sql')
	db.exec(`
		INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at
		) VALUES
			('user-a', 'package:abc', 'unknown', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
			('user-a', 'service:abc', 'unknown', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z'),
			('user-a', 'job:abc', 'job', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
	`)
	applyMigration(db, '0108-user-storage-buckets-package-kind.sql')
	const rows = db
		.prepare(
			`SELECT storage_id, kind FROM user_storage_buckets ORDER BY storage_id ASC`,
		)
		.all() as Array<{ storage_id: string; kind: string }>
	expect(rows).toEqual([
		{ storage_id: 'job:abc', kind: 'job' },
		{ storage_id: 'package:abc', kind: 'package' },
		{ storage_id: 'service:abc', kind: 'service' },
	])
	db.exec(`
		INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at
		) VALUES (
			'user-a', 'package:fresh', 'package',
			'2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z'
		);
	`)
	expect(
		db
			.prepare(
				`SELECT kind FROM user_storage_buckets WHERE storage_id = 'package:fresh'`,
			)
			.get() as { kind: string },
	).toEqual({ kind: 'package' })
})
