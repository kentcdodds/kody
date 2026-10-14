import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0142-users-personal-org-id.sql'

function migrationSql() {
	return readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8')
}

function applyMigrationsBefore(db: DatabaseSync, fileName: string) {
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < fileName)
		.sort()) {
		db.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
}

function applyMigrationSkippingDuplicateColumns(db: DatabaseSync, sql: string) {
	const statements = sql
		.split('\n')
		.filter((line) => !line.trimStart().startsWith('--'))
		.join('\n')
		.split(';')
		.map((statement) => statement.trim())
		.filter(Boolean)
	for (const statement of statements) {
		try {
			db.exec(`${statement};`)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (message.includes('duplicate column name')) continue
			throw error
		}
	}
}

function databaseBeforeMigration() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, migrationFileName)
	return sqlite
}

test('0142 backfills personal_org_id to stable_user_id for live and deleted users', () => {
	const sqlite = databaseBeforeMigration()
	sqlite.exec(`
		INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('ada', 'ada@example.com', 'hash', 'person-ada');
		INSERT INTO orgs (id, slug, created_at, updated_at)
		VALUES (
			'person-ada', 'ada', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
		);
		INSERT INTO users (
			username, email, password_hash, stable_user_id, deleted_at
		) VALUES (
			'gone', 'gone@example.com', 'hash', 'person-gone',
			'2026-02-01T00:00:00.000Z'
		);
	`)

	sqlite.exec(migrationSql())

	expect(
		sqlite
			.prepare(
				`SELECT username, stable_user_id, personal_org_id
				 FROM users ORDER BY username`,
			)
			.all(),
	).toEqual([
		{
			username: 'ada',
			stable_user_id: 'person-ada',
			personal_org_id: 'person-ada',
		},
		{
			username: 'gone',
			stable_user_id: 'person-gone',
			personal_org_id: 'person-gone',
		},
	])
	expect(
		sqlite.prepare(`SELECT id FROM orgs WHERE slug = 'ada'`).get(),
	).toEqual({ id: 'person-ada' })
	expect(
		sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE name = '__migration_assertions'`,
			)
			.all(),
	).toEqual([])
	expect(
		sqlite
			.prepare(
				`SELECT sql FROM sqlite_master
				 WHERE type = 'index' AND name = 'idx_users_personal_org_id'`,
			)
			.get(),
	).toMatchObject({
		sql: expect.stringContaining('deleted_at IS NULL'),
	})

	expect(() =>
		sqlite.exec(`
			INSERT INTO users (
				username, email, password_hash, stable_user_id, personal_org_id
			) VALUES (
				'bea', 'bea@example.com', 'hash', 'person-bea', 'person-ada'
			);
		`),
	).toThrow(/UNIQUE constraint failed/)

	sqlite.exec(`
		INSERT INTO users (
			username, email, password_hash, stable_user_id, personal_org_id, deleted_at
		) VALUES (
			'bea', 'bea@example.com', 'hash', 'person-bea', 'person-ada',
			'2026-03-01T00:00:00.000Z'
		);
	`)
})

test('0142 replaces a blank personal_org_id and fails when a live user stays blank', () => {
	const sqlite = databaseBeforeMigration()
	sqlite.exec(`ALTER TABLE users ADD COLUMN personal_org_id TEXT`)
	sqlite.exec(`
		INSERT INTO users (
			username, email, password_hash, stable_user_id, personal_org_id
		) VALUES ('ada', 'ada@example.com', 'hash', 'person-ada', '   ');
	`)
	applyMigrationSkippingDuplicateColumns(sqlite, migrationSql())
	expect(
		sqlite
			.prepare(`SELECT personal_org_id FROM users WHERE username = 'ada'`)
			.get(),
	).toEqual({ personal_org_id: 'person-ada' })

	const blank = databaseBeforeMigration()
	blank.exec(`
		INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('blank', 'blank@example.com', 'hash', '');
	`)
	expect(() => blank.exec(migrationSql())).toThrow(/CHECK constraint failed/)
})

test('0142 fails when personal_org_id is already a different id', () => {
	const sqlite = databaseBeforeMigration()
	sqlite.exec(`ALTER TABLE users ADD COLUMN personal_org_id TEXT`)
	sqlite.exec(`
		INSERT INTO users (
			username, email, password_hash, stable_user_id, personal_org_id
		) VALUES ('ada', 'ada@example.com', 'hash', 'person-ada', 'other-org');
	`)
	expect(() =>
		applyMigrationSkippingDuplicateColumns(sqlite, migrationSql()),
	).toThrow(/CHECK constraint failed/)
})
