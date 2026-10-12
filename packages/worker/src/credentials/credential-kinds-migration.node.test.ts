import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0117-credential-kinds.sql'

function databaseBeforeMigration() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < migrationFileName)
		.sort()) {
		sqlite.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
	sqlite.exec(`
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-a', 'org-a', 'user', '');
		INSERT INTO secret_entries (bucket_id, name, encrypted_value)
		VALUES ('bucket-a', 'OPENAI_KEY', 'ct'), ('bucket-a', 'SLACK_HOOK', 'ct');
	`)
	return sqlite
}

test('0117 makes every existing credential a secret and accepts only known kinds', () => {
	const sqlite = databaseBeforeMigration()
	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)
	expect(
		sqlite.prepare(`SELECT name, kind FROM secret_entries ORDER BY name`).all(),
	).toEqual([
		{ name: 'OPENAI_KEY', kind: 'secret' },
		{ name: 'SLACK_HOOK', kind: 'secret' },
	])
	sqlite.exec(
		`UPDATE secret_entries SET kind = 'url' WHERE name = 'SLACK_HOOK'`,
	)
	expect(() =>
		sqlite.exec(
			`UPDATE secret_entries SET kind = 'password' WHERE name = 'OPENAI_KEY'`,
		),
	).toThrow(/CHECK constraint failed/)
})
