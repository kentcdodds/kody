CREATE TABLE IF NOT EXISTS package_invocation_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL,
	display_name TEXT NOT NULL,
	package_ids_json TEXT NOT NULL DEFAULT '[]',
	package_kody_ids_json TEXT NOT NULL DEFAULT '[]',
	export_names_json TEXT NOT NULL DEFAULT '[]',
	sources_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_package_invocation_tokens_user_id
ON package_invocation_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_package_invocation_tokens_token_hash
ON package_invocation_tokens(token_hash);

CREATE TABLE IF NOT EXISTS package_invocations (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	token_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	package_kody_id TEXT NOT NULL,
	export_name TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	source TEXT,
	topic TEXT,
	status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
	response_json TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_package_invocations_identity
ON package_invocations(
	user_id,
	token_id,
	package_id,
	export_name,
	idempotency_key
);

CREATE INDEX IF NOT EXISTS idx_package_invocations_user_created_at
ON package_invocations(user_id, created_at);
