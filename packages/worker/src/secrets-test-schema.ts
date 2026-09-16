/**
 * Workers-unit D1 does not apply migrations. Suites that call packageGet
 * (which lists package-scoped secret metadata) need these tables.
 */
export async function ensureSecretBucketsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS secret_buckets (
				id TEXT PRIMARY KEY NOT NULL,
				user_id TEXT NOT NULL,
				scope TEXT NOT NULL CHECK (scope IN ('session', 'package', 'user')),
				binding_key TEXT NOT NULL,
				expires_at TEXT,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				UNIQUE(user_id, scope, binding_key)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS secret_entries (
				bucket_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				encrypted_value TEXT NOT NULL,
				allowed_hosts TEXT NOT NULL DEFAULT '[]',
				allowed_packages TEXT NOT NULL DEFAULT '[]',
				lookup_hash TEXT,
				expires_at TEXT,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				PRIMARY KEY (bucket_id, name)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS secret_provider_bindings (
				user_id TEXT NOT NULL,
				provider_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				door_secret_name TEXT NOT NULL,
				config_json TEXT NOT NULL DEFAULT '{}',
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				PRIMARY KEY (user_id, provider_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS secret_provider_grants (
				user_id TEXT NOT NULL,
				provider_id TEXT NOT NULL,
				canonical_ref TEXT NOT NULL,
				package_id TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				PRIMARY KEY (user_id, provider_id, canonical_ref, package_id)
			)`,
		)
		.run()
}
