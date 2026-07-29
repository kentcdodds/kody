import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)
const strandedAppValueBucketsMigration =
	'0109-delete-stranded-app-value-buckets.sql'

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

const now = '2026-07-01T00:00:00.000Z'

test('stranded job/exec app value buckets migration deletes fallback rows only', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, strandedAppValueBucketsMigration)
	db.exec('PRAGMA foreign_keys = ON')

	db.exec(`
		INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, has_app,
			created_at, updated_at
		) VALUES
			(
				'pkg-real-1', 'user-a', '@a/notes', 'notes', 'Notes',
				'source-pkg-1', 1, '${now}', '${now}'
			),
			(
				'job:guarded-package', 'user-a', '@a/guarded', 'guarded', 'Guarded',
				'source-pkg-2', 0, '${now}', '${now}'
			);

		INSERT INTO value_buckets (
			id, user_id, scope, binding_key, expires_at, created_at, updated_at
		) VALUES
			('bucket-job', 'user-a', 'app', 'job:job-123', NULL, '${now}', '${now}'),
			('bucket-exec', 'user-a', 'app', 'exec:exec-456', NULL, '${now}', '${now}'),
			('bucket-pkg', 'user-a', 'app', 'pkg-real-1', NULL, '${now}', '${now}'),
			(
				'bucket-guarded', 'user-a', 'app', 'job:guarded-package',
				NULL, '${now}', '${now}'
			),
			('bucket-user', 'user-a', 'user', '', NULL, '${now}', '${now}');

		INSERT INTO value_entries (
			bucket_id, name, description, value, created_at, updated_at
		) VALUES
			('bucket-job', 'workspaceSlug', '', 'job-value', '${now}', '${now}'),
			('bucket-exec', 'workspaceSlug', '', 'exec-value', '${now}', '${now}'),
			('bucket-pkg', 'workspaceSlug', '', 'pkg-value', '${now}', '${now}'),
			(
				'bucket-guarded', 'workspaceSlug', '', 'guarded-value',
				'${now}', '${now}'
			),
			('bucket-user', 'workspaceSlug', '', 'user-value', '${now}', '${now}');
	`)

	applyMigration(db, strandedAppValueBucketsMigration)

	const buckets = db
		.prepare(
			`SELECT id, scope, binding_key
			FROM value_buckets
			ORDER BY id ASC`,
		)
		.all() as Array<{ id: string; scope: string; binding_key: string }>
	expect(buckets).toEqual([
		{
			id: 'bucket-guarded',
			scope: 'app',
			binding_key: 'job:guarded-package',
		},
		{ id: 'bucket-pkg', scope: 'app', binding_key: 'pkg-real-1' },
		{ id: 'bucket-user', scope: 'user', binding_key: '' },
	])

	const entries = db
		.prepare(
			`SELECT bucket_id, name, value
			FROM value_entries
			ORDER BY bucket_id ASC`,
		)
		.all() as Array<{ bucket_id: string; name: string; value: string }>
	expect(entries).toEqual([
		{
			bucket_id: 'bucket-guarded',
			name: 'workspaceSlug',
			value: 'guarded-value',
		},
		{ bucket_id: 'bucket-pkg', name: 'workspaceSlug', value: 'pkg-value' },
		{ bucket_id: 'bucket-user', name: 'workspaceSlug', value: 'user-value' },
	])
})
