/**
 * Mirrors the `usage_rollups` and `usage_attribution_daily` schemas for
 * `*.workers.test.ts` suites, which run against a local D1 database without
 * applying migrations.
 */
export async function ensureUsageRollupsTestSchema(db: D1Database) {
	const statements = [
		`DROP TABLE IF EXISTS usage_attribution_daily;`,
		`DROP TABLE IF EXISTS usage_rollups;`,
		`CREATE TABLE usage_rollups (
	user_id TEXT NOT NULL,
	metric TEXT NOT NULL,
	month TEXT NOT NULL,
	event_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	total_duration_ms INTEGER NOT NULL DEFAULT 0,
	total_cpu_ms INTEGER NOT NULL DEFAULT 0,
	total_bytes INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, metric, month)
);`,
		`CREATE INDEX idx_usage_rollups_user_month
ON usage_rollups(user_id, month);`,
		`CREATE TABLE usage_attribution_daily (
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	package_id TEXT NOT NULL,
	meter TEXT NOT NULL,
	units REAL NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, day, package_id, meter)
);`,
		`CREATE INDEX idx_usage_attribution_daily_user_month
ON usage_attribution_daily(user_id, day);`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
