CREATE TABLE saved_packages (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	kody_id TEXT NOT NULL,
	description TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	search_text TEXT,
	source_id TEXT NOT NULL,
	has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX idx_saved_packages_user_kody_id
ON saved_packages(user_id, kody_id);

CREATE UNIQUE INDEX idx_saved_packages_user_name
ON saved_packages(user_id, name);

CREATE UNIQUE INDEX idx_saved_packages_source_id
ON saved_packages(source_id);
