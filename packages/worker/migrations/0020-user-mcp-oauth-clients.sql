-- Account-owned confidential MCP OAuth clients (Kody as authorization
-- server). The plaintext client secret is returned once at mint time and
-- is never stored here; workers-oauth-provider keeps the hash in OAUTH_KV.
CREATE TABLE user_mcp_oauth_clients (
	id TEXT PRIMARY KEY NOT NULL,
	user_id INTEGER NOT NULL,
	client_id TEXT NOT NULL,
	label TEXT NOT NULL,
	redirect_uris_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	revoked_at TEXT,
	FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_user_mcp_oauth_clients_client_id
	ON user_mcp_oauth_clients (client_id);

CREATE INDEX idx_user_mcp_oauth_clients_user_id
	ON user_mcp_oauth_clients (user_id);
