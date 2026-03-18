CREATE TABLE IF NOT EXISTS chat_threads (
	id TEXT PRIMARY KEY NOT NULL,
	user_id INTEGER NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	last_message_preview TEXT NOT NULL DEFAULT '',
	message_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	deleted_at TEXT,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_user_updated_at
	ON chat_threads(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_threads_user_deleted_at
	ON chat_threads(user_id, deleted_at);
