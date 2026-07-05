/**
 * Mirrors `packages/worker/migrations/0047-usage-rollups.sql` for
 * `*.workers.test.ts` suites, which run against a local D1 database without
 * applying migrations.
 */
export async function ensureUsageRollupsTestSchema(db: D1Database) {
	const statements = [
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
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
