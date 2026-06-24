DROP TABLE IF EXISTS repo_sessions;

CREATE TABLE repo_sessions (
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
);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_user_id
ON repo_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_source_id
ON repo_sessions(source_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_conversation_id
ON repo_sessions(conversation_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_cleanup
ON repo_sessions(status, expires_at, updated_at);
