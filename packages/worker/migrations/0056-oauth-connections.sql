-- Social login (GitHub / Google / X) identity links. One row per external
-- provider identity; a user may have at most one connection per provider
-- identity, and each provider identity maps to exactly one user.
CREATE TABLE IF NOT EXISTS oauth_connections (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	provider_name TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	user_id INTEGER NOT NULL,
	provider_display_name TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (provider_name, provider_id),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_connections_user_id ON oauth_connections(user_id);
