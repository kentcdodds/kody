CREATE TABLE IF NOT EXISTS journal_entries (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '[]',
	entry_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_user_updated_at
	ON journal_entries(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_journal_entries_user_entry_at
	ON journal_entries(user_id, entry_at DESC);
