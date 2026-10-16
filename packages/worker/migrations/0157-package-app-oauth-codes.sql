-- Single-use package-app OAuth authorization codes (D1, not KV) so consume is
-- atomic: DELETE … RETURNING fails closed under concurrent exchange.

CREATE TABLE package_app_oauth_codes (
	code_hash TEXT PRIMARY KEY NOT NULL,
	payload TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX package_app_oauth_codes_expires_at_idx
	ON package_app_oauth_codes (expires_at);
