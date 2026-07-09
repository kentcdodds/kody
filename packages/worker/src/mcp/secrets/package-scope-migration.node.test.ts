import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)

function applyMigration(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

test('package scope migration converts app buckets without retaining package grants', () => {
	const db = new DatabaseSync(':memory:')
	for (const fileName of [
		'0008-secret-buckets.sql',
		'0009-secret-allowed-hosts.sql',
		'0010-secret-allowed-capabilities.sql',
		'0022-secret-entry-lookup-hash.sql',
		'0023-secret-allowed-packages.sql',
	]) {
		applyMigration(db, fileName)
	}
	db.exec(`
		CREATE TABLE jobs (
			user_id TEXT NOT NULL,
			source_id TEXT,
			caller_context_json TEXT NOT NULL
		);
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL
		);
		INSERT INTO saved_packages (id, user_id, source_id)
		VALUES ('package-1', 'user-1', 'package-source-1');
		INSERT INTO jobs (user_id, source_id, caller_context_json)
		VALUES (
			'user-1',
			'ad-hoc-job-source-1',
			'{"storageContext":{"appId":"package-1"}}'
		);
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES
			('package-bucket', 'user-1', 'app', 'package-1'),
			('user-bucket', 'user-1', 'user', '');
		INSERT INTO secret_entries (
			bucket_id,
			name,
			encrypted_value,
			allowed_packages
		)
		VALUES
			('package-bucket', 'package-token', 'encrypted-package', '["package-2"]'),
			('user-bucket', 'shared-token', 'encrypted-user', '["package-2"]');
	`)

	applyMigration(db, '0057-package-scoped-secrets.sql')

	expect(
		db
			.prepare(
				`SELECT scope, binding_key
				FROM secret_buckets
				WHERE id = 'package-bucket'`,
			)
			.get(),
	).toEqual({ scope: 'package', binding_key: 'package-1' })
	expect(
		db
			.prepare(
				`SELECT encrypted_value, allowed_packages
				FROM secret_entries
				WHERE bucket_id = 'package-bucket'`,
			)
			.get(),
	).toEqual({
		encrypted_value: 'encrypted-package',
		allowed_packages: '[]',
	})
	expect(
		db
			.prepare(
				`SELECT allowed_packages
				FROM secret_entries
				WHERE bucket_id = 'user-bucket'`,
			)
			.get(),
	).toEqual({ allowed_packages: '["package-2"]' })
	expect(
		db
			.prepare(
				`SELECT json_extract(
					caller_context_json,
					'$.storageContext.packageId'
				) AS package_id
				FROM jobs`,
			)
			.get(),
	).toEqual({ package_id: 'package-1' })
	expect(() =>
		db.exec(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key)
			VALUES ('legacy-app-bucket', 'user-1', 'app', 'package-2')`,
		),
	).toThrow()
})
