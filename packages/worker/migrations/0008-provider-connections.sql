CREATE TABLE IF NOT EXISTS connection_drafts (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	provider_key TEXT NOT NULL,
	display_name TEXT NOT NULL,
	label TEXT,
	auth_spec_json TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'draft',
	state_json TEXT,
	error_message TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connection_drafts_user_provider
	ON connection_drafts(user_id, provider_key);

CREATE INDEX IF NOT EXISTS idx_connection_drafts_expires_at
	ON connection_drafts(expires_at);

CREATE TABLE IF NOT EXISTS connection_draft_secrets (
	draft_id TEXT NOT NULL,
	secret_name TEXT NOT NULL,
	encrypted_value TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (draft_id, secret_name),
	FOREIGN KEY (draft_id) REFERENCES connection_drafts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_connections (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	provider_key TEXT NOT NULL,
	display_name TEXT NOT NULL,
	label TEXT NOT NULL,
	auth_spec_json TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	account_id TEXT,
	account_label TEXT,
	scope_set TEXT,
	metadata_json TEXT,
	is_default INTEGER NOT NULL DEFAULT 0,
	token_expires_at TEXT,
	last_used_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_user_provider
	ON provider_connections(user_id, provider_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_default
	ON provider_connections(user_id, provider_key)
	WHERE is_default = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_user_label
	ON provider_connections(user_id, provider_key, label);

CREATE TABLE IF NOT EXISTS provider_connection_secrets (
	connection_id TEXT PRIMARY KEY NOT NULL,
	encrypted_secret_json TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
);
