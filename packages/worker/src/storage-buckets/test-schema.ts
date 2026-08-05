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

/**
 * Minimal `repo_sessions` schema (mirrors the squashed baseline) for suites
 * exercising the session-bucket inventory reconciliation, which joins
 * `repo_sessions` against `user_storage_buckets`.
 */
export async function ensureRepoSessionsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS repo_sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	source_repo_id TEXT NOT NULL,
	session_branch TEXT NOT NULL,
	source_branch TEXT NOT NULL,
	base_commit TEXT NOT NULL,
	source_root TEXT NOT NULL DEFAULT '/',
	conversation_id TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	expires_at TEXT,
	last_checkpoint_at TEXT,
	last_checkpoint_commit TEXT,
	last_check_run_id TEXT,
	last_check_tree_hash TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
)`,
		)
		.run()
}
