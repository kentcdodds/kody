CREATE TABLE IF NOT EXISTS repo_sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	session_repo_id TEXT NOT NULL,
	session_repo_name TEXT NOT NULL,
	session_repo_namespace TEXT NOT NULL DEFAULT 'default',
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
);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_user_id
ON repo_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_source_id
ON repo_sessions(source_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_conversation_id
ON repo_sessions(conversation_id);

ALTER TABLE mcp_skills
ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_skills_source_id
ON mcp_skills(source_id);

ALTER TABLE ui_artifacts
ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ui_artifacts_source_id
ON ui_artifacts(source_id);

ALTER TABLE jobs
ADD COLUMN source_id TEXT;

ALTER TABLE jobs
ADD COLUMN published_commit TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_source_id
ON jobs(source_id);
