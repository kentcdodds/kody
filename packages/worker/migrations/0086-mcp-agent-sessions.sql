CREATE TABLE mcp_agent_sessions (
	do_id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_mcp_agent_sessions_user_id
ON mcp_agent_sessions(user_id);
