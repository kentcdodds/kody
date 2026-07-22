/**
 * Schema for package scope grant / platform account workers-unit tests.
 * Local D1 does not apply migrations, so suites provision the tables they need.
 * Mirrors users columns from early migrations plus 0052/0075 (stable_user_id)
 * and 0072 (account_type, package_scope_grants).
 */
export async function ensurePackageScopeGrantsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	username TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	email_verified_at TEXT,
	stable_user_id TEXT NOT NULL,
	account_type TEXT NOT NULL DEFAULT 'person' CHECK (account_type IN ('person', 'platform')),
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
)`,
		)
		.run()
	for (const column of [
		'email_verified_at TEXT',
		'stable_user_id TEXT',
		`account_type TEXT NOT NULL DEFAULT 'person'`,
	]) {
		try {
			await db.prepare(`ALTER TABLE users ADD COLUMN ${column}`).run()
		} catch {
			// Column already exists (fresh CREATE above or prior suite setup).
		}
	}
	try {
		await db
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
				 ON users(stable_user_id)`,
			)
			.run()
	} catch {
		// Index already exists or partial legacy index remains from an earlier suite.
	}
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
