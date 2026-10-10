-- Teams P9 contract: make `api_tokens.org_id` NOT NULL. Migration 0090
-- backfilled and asserted non-null; SQLite still stored the column as
-- nullable until this rebuild.

DROP TABLE IF EXISTS __migration_assertions;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'api_tokens.org_id is null or blank before NOT NULL rebuild; aborting 0101.'
WHERE EXISTS (
	SELECT 1 FROM api_tokens WHERE org_id IS NULL OR TRIM(org_id) = ''
);

DROP TABLE __migration_assertions;

CREATE TABLE api_tokens_next (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	scopes_json TEXT NOT NULL,
	idle_ttl_seconds INTEGER NOT NULL,
	expires_at TEXT NOT NULL,
	max_expires_at TEXT NOT NULL,
	created_via TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_used_at TEXT,
	rotated_at TEXT,
	revoked_at TEXT,
	profile_name TEXT,
	deleted_at TEXT,
	deleting_at TEXT
);

INSERT INTO api_tokens_next (
	id,
	user_id,
	org_id,
	name,
	token_hash,
	scopes_json,
	idle_ttl_seconds,
	expires_at,
	max_expires_at,
	created_via,
	created_at,
	updated_at,
	last_used_at,
	rotated_at,
	revoked_at,
	profile_name,
	deleted_at,
	deleting_at
)
SELECT
	id,
	user_id,
	org_id,
	name,
	token_hash,
	scopes_json,
	idle_ttl_seconds,
	expires_at,
	max_expires_at,
	created_via,
	created_at,
	updated_at,
	last_used_at,
	rotated_at,
	revoked_at,
	profile_name,
	deleted_at,
	deleting_at
FROM api_tokens;

DROP TABLE api_tokens;

ALTER TABLE api_tokens_next RENAME TO api_tokens;

CREATE INDEX api_tokens_user_created_idx ON api_tokens (user_id, created_at);
CREATE INDEX api_tokens_org_user_idx ON api_tokens (org_id, user_id);
