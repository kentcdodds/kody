CREATE TABLE IF NOT EXISTS mcp_user_server_instructions (
	user_id TEXT PRIMARY KEY NOT NULL,
	instructions TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
