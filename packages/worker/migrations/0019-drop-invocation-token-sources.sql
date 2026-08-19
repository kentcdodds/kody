-- Invocation tokens no longer store a source allowlist. Request JSON
-- `source` stays an optional label for logs and does not gate auth.

CREATE TABLE package_invocation_tokens_next (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	export_names_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT
);

INSERT INTO package_invocation_tokens_next (
	id,
	user_id,
	package_id,
	name,
	token_hash,
	export_names_json,
	created_at,
	updated_at,
	last_used_at,
	revoked_at
)
SELECT
	id,
	user_id,
	package_id,
	name,
	token_hash,
	export_names_json,
	created_at,
	updated_at,
	last_used_at,
	revoked_at
FROM package_invocation_tokens;

DROP TABLE package_invocation_tokens;
ALTER TABLE package_invocation_tokens_next RENAME TO package_invocation_tokens;

CREATE INDEX idx_package_invocation_tokens_user_package
ON package_invocation_tokens(user_id, package_id);

CREATE UNIQUE INDEX idx_package_invocation_tokens_user_package_hash
ON package_invocation_tokens(user_id, package_id, token_hash);
