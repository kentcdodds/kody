ALTER TABLE repo_sessions
	ADD COLUMN source_repo_id TEXT;

ALTER TABLE repo_sessions
	ADD COLUMN session_branch TEXT;

ALTER TABLE repo_sessions
	ADD COLUMN source_branch TEXT;

UPDATE repo_sessions
SET source_repo_id = session_repo_name,
	session_branch = 'sessions/' || id,
	source_branch = 'main',
	status = 'discarded',
	expires_at = COALESCE(expires_at, CURRENT_TIMESTAMP),
	updated_at = CURRENT_TIMESTAMP
WHERE session_branch IS NULL;

CREATE INDEX IF NOT EXISTS idx_repo_sessions_user_id
ON repo_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_source_id
ON repo_sessions(source_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_conversation_id
ON repo_sessions(conversation_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_cleanup
ON repo_sessions(status, expires_at, updated_at);
