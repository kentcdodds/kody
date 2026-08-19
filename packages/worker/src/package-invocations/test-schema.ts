/**
 * Workers-unit D1 does not apply migrations. Suites that call package_get
 * (which lists tokens) need this table.
 */
export async function ensurePackageInvocationTokensTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS package_invocation_tokens (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				name TEXT NOT NULL,
				token_hash TEXT NOT NULL,
				export_names_json TEXT NOT NULL DEFAULT '[]',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_used_at TEXT,
				revoked_at TEXT
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_package_invocation_tokens_user_package
			ON package_invocation_tokens(user_id, package_id)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_package_invocation_tokens_user_package_hash
			ON package_invocation_tokens(user_id, package_id, token_hash)`,
		)
		.run()
}
