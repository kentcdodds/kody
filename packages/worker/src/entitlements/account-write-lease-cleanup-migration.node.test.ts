import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const cleanupMigration =
	'0141-drop-account-write-leases-and-stale-flags.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

test('0141 drops the D1 lease table and removes only retired flags', () => {
	const db = new DatabaseSync(':memory:')
	db.exec('PRAGMA foreign_keys = ON')
	applyMigrationsBefore(db, cleanupMigration)
	db.exec(`
		INSERT INTO users (
			username, email, password_hash, stable_user_id, plan
		) VALUES (
			'migration-user', 'migration-user@example.com', 'test-hash',
			'usr_0141migrationuser', 'free'
		);
		INSERT INTO account_write_leases (
			token, user_id, holder, acquired_at, released_at
		) VALUES (
			'retired-lease', 'usr_0141migrationuser', 'test-holder',
			'2026-08-03T00:00:00.000Z', NULL
		);
		INSERT INTO feature_flags (key, enabled, note)
		VALUES
			('demo-indicator', 1, 'keep'),
			('execute-pre-exec-typecheck', 1, 'remove'),
			('mailbox-read-cutover', 1, 'remove');
		INSERT INTO feature_flag_user_overrides (
			flag_key, user_id, enabled
		)
		SELECT 'execute-pre-exec-typecheck', id, 1
		FROM users
		WHERE username = 'migration-user';
	`)

	const sql = readFileSync(new URL(cleanupMigration, migrationsDirectory), 'utf8')
	db.exec(sql)
	db.exec(sql)

	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name = 'account_write_leases'`,
			)
			.all(),
	).toEqual([])
	expect(db.prepare(`SELECT key FROM feature_flags ORDER BY key`).all()).toEqual([
		{ key: 'demo-indicator' },
	])
	expect(
		db.prepare(`SELECT flag_key FROM feature_flag_user_overrides`).all(),
	).toEqual([])
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				WHERE type = 'table' AND name = 'account_write_lease_repairs'`,
			)
			.all(),
	).toEqual([{ name: 'account_write_lease_repairs' }])
})
