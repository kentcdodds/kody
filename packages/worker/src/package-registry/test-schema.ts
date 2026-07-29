import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

/**
 * Schema for package scope grant / platform account workers-unit tests.
 * Local D1 does not apply migrations, so suites provision the tables they need.
 * Adds migration 0072 (`users.account_type`, `package_scope_grants`) and the
 * audit rows those mutations write on top of the shared `users` schema.
 */
export async function ensurePackageScopeGrantsTestSchema(db: D1Database) {
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at', 'account_type'],
	})
	await db.prepare(`DROP TABLE IF EXISTS package_scope_grants`).run()
	await db
		.prepare(
			`CREATE TABLE package_scope_grants (
	scope_owner_user_id TEXT NOT NULL,
	grantee_user_id TEXT NOT NULL,
	created_by_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (scope_owner_user_id, grantee_user_id),
	CHECK (scope_owner_user_id != grantee_user_id)
)`,
		)
		.run()
	await db
		.prepare(
			`CREATE INDEX idx_package_scope_grants_grantee_user_id
ON package_scope_grants(grantee_user_id)`,
		)
		.run()
	// Delegated scope resolution and admin grant mutations write audit rows.
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS audit_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	category TEXT NOT NULL CHECK (category IN ('account', 'admin', 'auth', 'oauth')),
	action TEXT NOT NULL,
	result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'rate_limited')),
	email_hash TEXT,
	ip_hash TEXT,
	client_id TEXT,
	path TEXT,
	reason TEXT,
	timestamp TEXT NOT NULL
)`,
		)
		.run()
}
