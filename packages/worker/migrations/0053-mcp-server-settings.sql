CREATE TABLE IF NOT EXISTS mcp_server_settings (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	url TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_settings_user_enabled
	ON mcp_server_settings(user_id, enabled);
