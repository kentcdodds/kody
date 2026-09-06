/**
 * Local D1 workers-unit suites do not apply migrations. Suites that create
 * accounts through `allocateSignupIdentity` / `claimAccountEmail` need these
 * tables (migration 0045).
 */
export async function ensureEmailClaimsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS user_email_claims (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				user_id INTEGER NOT NULL,
				email TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('claimed', 'released')),
				claimed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				released_at TEXT,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				UNIQUE (user_id, email)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_claims_active_email
			 ON user_email_claims(email)
			 WHERE status = 'claimed'`,
		)
		.run()
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_user_email_claims_user_id
			 ON user_email_claims(user_id)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS pending_email_claim_releases (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				user_id INTEGER NOT NULL,
				email TEXT NOT NULL,
				token_hash TEXT NOT NULL UNIQUE,
				expires_at INTEGER NOT NULL,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_claim_releases_user_email
			 ON pending_email_claim_releases(user_id, email)`,
		)
		.run()
}
