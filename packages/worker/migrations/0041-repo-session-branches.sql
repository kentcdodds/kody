DROP TABLE IF EXISTS repo_sessions_next;

CREATE TABLE repo_sessions_next (
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

INSERT INTO repo_sessions_next (
	id,
	user_id,
	source_id,
	source_repo_id,
	session_branch,
	source_branch,
	base_commit,
	source_root,
	conversation_id,
	status,
	expires_at,
	last_checkpoint_at,
	last_checkpoint_commit,
	last_check_run_id,
	last_check_tree_hash,
	created_at,
	updated_at
)
SELECT
	session.id,
	session.user_id,
	session.source_id,
	COALESCE(source.repo_id, session.session_repo_name),
	'sessions/' || session.id,
	'main',
	session.base_commit,
	session.source_root,
	session.conversation_id,
	'discarded',
	COALESCE(session.expires_at, CURRENT_TIMESTAMP),
	session.last_checkpoint_at,
	session.last_checkpoint_commit,
	session.last_check_run_id,
	session.last_check_tree_hash,
	session.created_at,
	CURRENT_TIMESTAMP
FROM repo_sessions AS session
LEFT JOIN entity_sources AS source
	ON source.id = session.source_id;

DROP TABLE repo_sessions;

ALTER TABLE repo_sessions_next
	RENAME TO repo_sessions;

CREATE INDEX IF NOT EXISTS idx_repo_sessions_user_id
ON repo_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_source_id
ON repo_sessions(source_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_conversation_id
ON repo_sessions(conversation_id);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_cleanup
ON repo_sessions(status, expires_at, updated_at);
