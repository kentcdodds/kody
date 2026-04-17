CREATE TABLE IF NOT EXISTS entity_sources (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	entity_kind TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	repo_id TEXT NOT NULL,
	published_commit TEXT,
	indexed_commit TEXT,
	manifest_path TEXT NOT NULL DEFAULT 'kody.json',
	source_root TEXT NOT NULL DEFAULT '/',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_sources_user_entity
ON entity_sources(user_id, entity_kind, entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_sources_repo_id
ON entity_sources(repo_id);

CREATE INDEX IF NOT EXISTS idx_entity_sources_user_id
ON entity_sources(user_id);
