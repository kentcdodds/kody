import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const snapshotNarrowMigration =
	'0114-platform-feedback-submitter-snapshots-not-null.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	db.exec('PRAGMA foreign_keys = ON')
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function applyMigrationLikeD1(db: DatabaseSync, fileName: string) {
	const sql = readFileSync(new URL(fileName, migrationsDirectory), 'utf8')
	db.exec('BEGIN')
	try {
		db.exec(sql)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

function seedSnapshotRows(db: DatabaseSync) {
	db.exec(`
		INSERT INTO users (
			id, username, email, password_hash, stable_user_id, plan
		) VALUES (
			1, 'matched-user', 'matched@example.com', 'hash', 'matched-stable-id',
			'free'
		);

		INSERT INTO platform_feedback (
			id, submitter_user_id, submitter_username, submitter_email, category,
			summary, details, created_at, updated_at
		) VALUES
			(
				'backfilled', 'matched-stable-id', NULL, NULL, 'friction',
				'Backfill both', 'Backfill both snapshots', '2026-07-19', '2026-07-19'
			),
			(
				'partially-backfilled', 'matched-stable-id', 'original-name', NULL,
				'bug', 'Backfill email', 'Preserve the existing username',
				'2026-07-20', '2026-07-20'
			),
			(
				'orphaned', 'missing-stable-id', NULL, NULL, 'suggestion',
				'Delete me', 'No matching user exists', '2026-07-21', '2026-07-21'
			),
			(
				'complete-orphan', 'deleted-user', 'deleted-name',
				'deleted@example.com', 'experience', 'Keep snapshots',
				'Complete snapshots do not need a live user', '2026-07-22', '2026-07-22'
			);
	`)
}

test('0114 backfills snapshots, deletes unresolvable rows, and enforces NOT NULL', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, snapshotNarrowMigration)
	seedSnapshotRows(db)

	applyMigrationLikeD1(db, snapshotNarrowMigration)

	expect(
		db
			.prepare(
				`SELECT id, submitter_username, submitter_email
				 FROM platform_feedback
				 ORDER BY id`,
			)
			.all(),
	).toEqual([
		{
			id: 'backfilled',
			submitter_username: 'matched-user',
			submitter_email: 'matched@example.com',
		},
		{
			id: 'complete-orphan',
			submitter_username: 'deleted-name',
			submitter_email: 'deleted@example.com',
		},
		{
			id: 'partially-backfilled',
			submitter_username: 'original-name',
			submitter_email: 'matched@example.com',
		},
	])
	const columns = db
		.prepare(`PRAGMA table_info(platform_feedback)`)
		.all() as Array<{ name: string; notnull: number }>
	expect(
		columns
			.filter((column) =>
				['submitter_username', 'submitter_email'].includes(column.name),
			)
			.map((column) => ({
				name: column.name,
				notnull: column.notnull,
			})),
	).toEqual([
		{ name: 'submitter_username', notnull: 1 },
		{ name: 'submitter_email', notnull: 1 },
	])
	expect(
		(
			db
				.prepare(
					`SELECT name
					 FROM sqlite_master
					 WHERE type = 'index'
					   AND tbl_name = 'platform_feedback'
					   AND sql IS NOT NULL
					 ORDER BY name`,
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name),
	).toEqual([
		'idx_platform_feedback_category_created_at_id',
		'idx_platform_feedback_created_at_id',
		'idx_platform_feedback_reviewer',
		'idx_platform_feedback_status_created_at_id',
		'idx_platform_feedback_submitter_created_at',
		'idx_platform_feedback_submitter_status',
		'idx_platform_feedback_terminal_updated_at_id',
	])
	expect(() =>
		db
			.prepare(
				`INSERT INTO platform_feedback (
					id, submitter_user_id, submitter_username, submitter_email,
					category, summary, details, created_at, updated_at
				) VALUES (
					'null-snapshot', 'matched-stable-id', NULL, 'matched@example.com',
					'bug', 'Invalid', 'Null username must fail', '2026-07-23',
					'2026-07-23'
				)`,
			)
			.run(),
	).toThrow(/NOT NULL constraint failed: platform_feedback\.submitter_username/)
	expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
	expect(
		db
			.prepare(
				`SELECT name
				 FROM sqlite_master
				 WHERE name = '__migration_assertions'
				    OR name = 'platform_feedback_next'`,
			)
			.all(),
	).toEqual([])
})

test('0114 aborts and rolls back when an unresolvable null snapshot survives cleanup', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, snapshotNarrowMigration)
	seedSnapshotRows(db)
	db.exec(`
		CREATE TRIGGER test_keep_orphaned_feedback_update
		BEFORE UPDATE ON platform_feedback
		WHEN OLD.id = 'orphaned'
		BEGIN
			SELECT RAISE(IGNORE);
		END;
		CREATE TRIGGER test_keep_orphaned_feedback_delete
		BEFORE DELETE ON platform_feedback
		WHEN OLD.id = 'orphaned'
		BEGIN
			SELECT RAISE(IGNORE);
		END;
	`)

	expect(() => applyMigrationLikeD1(db, snapshotNarrowMigration)).toThrow(
		/CHECK constraint failed: 0/,
	)
	expect(
		db
			.prepare(
				`SELECT submitter_username, submitter_email
				 FROM platform_feedback
				 WHERE id = 'orphaned'`,
			)
			.get(),
	).toEqual({ submitter_username: null, submitter_email: null })
	const columns = db
		.prepare(`PRAGMA table_info(platform_feedback)`)
		.all() as Array<{ name: string; notnull: number }>
	expect(
		columns
			.filter((column) =>
				['submitter_username', 'submitter_email'].includes(column.name),
			)
			.map((column) => column.notnull),
	).toEqual([0, 0])
})
