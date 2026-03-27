CREATE TABLE IF NOT EXISTS value_buckets (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('session', 'app', 'user')),
	binding_key TEXT NOT NULL,
	expires_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE(user_id, scope, binding_key)
);

CREATE INDEX IF NOT EXISTS idx_value_buckets_user_scope_binding
	ON value_buckets(user_id, scope, binding_key);

CREATE TABLE IF NOT EXISTS value_entries (
	bucket_id TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	value TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (bucket_id, name),
	FOREIGN KEY (bucket_id) REFERENCES value_buckets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_value_entries_bucket_id
	ON value_entries(bucket_id);

CREATE INDEX IF NOT EXISTS idx_value_entries_name
	ON value_entries(name);
