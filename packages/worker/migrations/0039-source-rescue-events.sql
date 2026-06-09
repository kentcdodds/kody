CREATE TABLE IF NOT EXISTS source_rescue_events (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	entity_kind TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	package_id TEXT,
	kody_id TEXT,
	source_repo_id TEXT NOT NULL,
	recovery_kind TEXT NOT NULL,
	recovered_session_id TEXT,
	recovered_repo_id TEXT,
	recovered_repo_name TEXT,
	recovered_commit TEXT,
	prior_published_commit TEXT,
	source_head_before TEXT,
	source_head_after TEXT,
	operator_user_id TEXT NOT NULL,
	operator_email TEXT,
	validation_status TEXT NOT NULL,
	validation_json TEXT NOT NULL,
	metadata_json TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_rescue_events_user_source
ON source_rescue_events(user_id, source_id, created_at);

CREATE INDEX IF NOT EXISTS idx_source_rescue_events_package
ON source_rescue_events(user_id, package_id, created_at);
