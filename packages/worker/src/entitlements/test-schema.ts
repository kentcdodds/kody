/**
 * Non-destructive schema for entitlement primitives in workers-unit tests,
 * where the D1 database starts empty and each suite provisions the tables it
 * needs. Mirrors migrations 0001 (users), 0046 (users.email_verified_at and
 * users.plan), 0048 (entitlement_daily_counters), 0052 (nullable
 * stable_user_id plus partial unique index), and 0066 (Stripe billing columns).
 */
export async function ensureEntitlementTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	username TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	email_verified_at TEXT,
	stable_user_id TEXT,
	plan TEXT,
	stripe_customer_id TEXT,
	stripe_plan TEXT,
	stripe_plan_refreshed_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
)`,
		)
		.run()
	for (const column of [
		'email_verified_at TEXT',
		'stable_user_id TEXT',
		'plan TEXT',
		'stripe_customer_id TEXT',
		'stripe_plan TEXT',
		'stripe_plan_refreshed_at TEXT',
	]) {
		try {
			await db.prepare(`ALTER TABLE users ADD COLUMN ${column}`).run()
		} catch {
			// The column already exists (fresh CREATE above or migrations).
		}
	}
	try {
		await db
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
				 ON users(stable_user_id)
				 WHERE stable_user_id IS NOT NULL`,
			)
			.run()
	} catch {
		// Index already exists or a full legacy index remains from an earlier suite.
	}
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS entitlement_daily_counters (
	user_id TEXT NOT NULL,
	resource TEXT NOT NULL,
	day TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, resource, day)
)`,
		)
		.run()
}
