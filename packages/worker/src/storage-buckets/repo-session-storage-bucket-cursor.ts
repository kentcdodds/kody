/**
 * Workers-unit D1 does not apply SQL migrations; production deploy does.
 * CREATE TABLE IF NOT EXISTS keeps local workers-unit and node-sqlite
 * fixtures aligned with 0012-repo-session-storage-bucket-cursor.sql.
 */
async function ensureRepoSessionStorageBucketCursorSchema(
	db: D1Database,
): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS repo_session_storage_bucket_cursor (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				position TEXT NOT NULL DEFAULT '',
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`INSERT OR IGNORE INTO repo_session_storage_bucket_cursor
			(singleton, position, updated_at)
			VALUES (1, '', ?)`,
		)
		.bind(new Date().toISOString())
		.run()
}

export async function readRepoSessionStorageBucketCursor(
	db: D1Database,
): Promise<string> {
	await ensureRepoSessionStorageBucketCursorSchema(db)
	const row = await db
		.prepare(
			`SELECT position FROM repo_session_storage_bucket_cursor
			WHERE singleton = 1`,
		)
		.first<{ position: string }>()
	return row?.position ?? ''
}

export async function writeRepoSessionStorageBucketCursor(input: {
	db: D1Database
	position: string
	now?: Date
}): Promise<void> {
	await ensureRepoSessionStorageBucketCursorSchema(input.db)
	await input.db
		.prepare(
			`UPDATE repo_session_storage_bucket_cursor
			SET position = ?, updated_at = ?
			WHERE singleton = 1`,
		)
		.bind(input.position, (input.now ?? new Date()).toISOString())
		.run()
}
