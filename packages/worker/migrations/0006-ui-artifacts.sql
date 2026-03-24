CREATE TABLE IF NOT EXISTS ui_artifacts (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	keywords TEXT NOT NULL,
	source_type TEXT NOT NULL,
	source_code TEXT NOT NULL,
	search_text TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_ui_artifacts_user_id ON ui_artifacts(user_id);
