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

test('user_storage_buckets migration backfills jobs, apps, and runtime-only buckets', () => {
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

		INSERT INTO package_runtime_runs (
			id, user_id, package_id, package_kody_id, surface, status,
			started_at, storage_id, created_at, updated_at
		) VALUES (
			'run-adhoc-1', 'user-a', 'pkg-none', 'none', 'export', 'success',
			'2026-07-06T00:00:00.000Z', 'exec:legacy-only',
			'2026-07-06T00:00:00.000Z', '2026-07-06T00:01:00.000Z'
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
			storage_id: 'exec:legacy-only',
			kind: 'unknown',
			created_at: '2026-07-06T00:00:00.000Z',
			last_seen_at: '2026-07-06T00:01:00.000Z',
		},
		{
			user_id: 'user-a',
			storage_id: 'job:job-1',
			kind: 'job',
			created_at: '2026-07-01T00:00:00.000Z',
			last_seen_at: '2026-07-02T00:00:00.000Z',
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
