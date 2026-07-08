CREATE TABLE IF NOT EXISTS auth_connections (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	user_id INTEGER NOT NULL,
	provider_name TEXT NOT NULL,
	provider_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	UNIQUE (provider_name, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_connections_user_id ON auth_connections(user_id);
