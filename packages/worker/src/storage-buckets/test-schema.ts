/**
 * Non-destructive schema for `user_storage_buckets` in workers-unit tests,
 * where the D1 database starts empty and each suite provisions the tables it
 * needs. Mirrors the squashed baseline plus
 * `0003-repo-session-storage-buckets.sql`.
 */
export async function ensureUserStorageBucketsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS user_storage_buckets (
	user_id TEXT NOT NULL,
	storage_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('job', 'package', 'service', 'execute', 'repo_session', 'unknown')),
	created_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	estimated_bytes INTEGER,
	estimated_bytes_updated_at TEXT,
	PRIMARY KEY (user_id, storage_id)
)`,
		)
		.run()
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_user_storage_buckets_user
			 ON user_storage_buckets(user_id)`,
		)
		.run()
}
