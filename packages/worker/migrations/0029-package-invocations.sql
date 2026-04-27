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
	status TEXT NOT NULL,
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
