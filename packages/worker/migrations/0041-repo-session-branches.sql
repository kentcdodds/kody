ALTER TABLE repo_sessions
	ADD COLUMN session_branch TEXT;

CREATE INDEX IF NOT EXISTS idx_repo_sessions_cleanup
ON repo_sessions(status, expires_at, updated_at);
