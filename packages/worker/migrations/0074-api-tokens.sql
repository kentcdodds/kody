-- Scoped, short-lived account API tokens for api.kody.codes (Open API) and the
-- local-execute CapabilityProxy. The plaintext is shown once at mint/rotate;
-- only a SHA-256 hash is stored. `expires_at` slides forward on use up to
-- `max_expires_at`. Lookups go through the primary key embedded in the token,
-- so there is no global hash index.
CREATE TABLE api_tokens (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
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
	revoked_at TEXT
);

CREATE INDEX api_tokens_user_created_idx ON api_tokens (user_id, created_at);
