import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const integrationSecretHygieneMigration =
	'0115-delete-integration-secret-values.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
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

function seedValues(db: DatabaseSync) {
	db.exec(`
		INSERT INTO value_buckets (id, user_id, scope, binding_key)
		VALUES
			('user-bucket', 'user-a', 'user', ''),
			('app-bucket', 'user-a', 'app', 'app-a'),
			('session-bucket', 'user-a', 'session', 'session-a');

		INSERT INTO value_entries (bucket_id, name, description, value)
		VALUES
			('user-bucket', '_integration-secret:fly', 'Integration secret binding', '{}'),
			('app-bucket', '_integration-secret:paypal', 'Integration secret binding', '{}'),
			('session-bucket', '_integration-secret:simplecast', 'Integration secret binding', '{}'),
			('user-bucket', '_integration:keep', 'Different legacy prefix', '{}'),
			('user-bucket', 'xintegration-secret:keep', 'Leading wildcard near miss', '{}'),
			('user-bucket', '_integration-secreta:keep', 'Prefix near miss', '{}'),
			('user-bucket', 'ordinary', 'Ordinary value', '{}');
	`)
}

test('0115 deletes only the literal integration-secret prefix across all scopes', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, integrationSecretHygieneMigration)
	seedValues(db)

	applyMigrationLikeD1(db, integrationSecretHygieneMigration)
	applyMigrationLikeD1(db, integrationSecretHygieneMigration)

	expect(
		db.prepare(`SELECT bucket_id, name FROM value_entries ORDER BY name`).all(),
	).toEqual([
		{ bucket_id: 'user-bucket', name: '_integration-secreta:keep' },
		{ bucket_id: 'user-bucket', name: '_integration:keep' },
		{ bucket_id: 'user-bucket', name: 'ordinary' },
		{ bucket_id: 'user-bucket', name: 'xintegration-secret:keep' },
	])
	expect(
		db
			.prepare(
				`SELECT COUNT(*) AS count
				 FROM value_entries
				 WHERE name LIKE '\\_integration-secret:%' ESCAPE '\\'`,
			)
			.get(),
	).toEqual({ count: 0 })
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE name = '__migration_assertions'`,
			)
			.all(),
	).toEqual([])
})

test('0115 aborts and rolls back when a matching value survives deletion', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, integrationSecretHygieneMigration)
	seedValues(db)
	db.exec(`
		CREATE TRIGGER test_keep_integration_secret_value
		BEFORE DELETE ON value_entries
		WHEN OLD.name = '_integration-secret:fly'
		BEGIN
			SELECT RAISE(IGNORE);
		END;
	`)
	const rowsBefore = db
		.prepare(`SELECT bucket_id, name FROM value_entries ORDER BY name`)
		.all()

	expect(() =>
		applyMigrationLikeD1(db, integrationSecretHygieneMigration),
	).toThrow(/CHECK constraint failed: 0/)
	expect(
		db.prepare(`SELECT bucket_id, name FROM value_entries ORDER BY name`).all(),
	).toEqual(rowsBefore)
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE name = '__migration_assertions'`,
			)
			.all(),
	).toEqual([])
})
