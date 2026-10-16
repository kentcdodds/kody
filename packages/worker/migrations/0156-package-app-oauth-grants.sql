-- First-party OAuth grants for hosted package apps (package is the client).
-- Authorization codes stay in KV (60s TTL); durable consent lives here.

CREATE TABLE package_app_oauth_grants (
	id TEXT PRIMARY KEY NOT NULL,
	person_id TEXT NOT NULL,
	org_username TEXT NOT NULL,
	kody_id TEXT NOT NULL,
	scopes TEXT NOT NULL,
	created_at TEXT NOT NULL,
	revoked_at TEXT
);

CREATE UNIQUE INDEX package_app_oauth_grants_person_app_live_idx
	ON package_app_oauth_grants (person_id, org_username, kody_id)
	WHERE revoked_at IS NULL;

CREATE INDEX package_app_oauth_grants_app_idx
	ON package_app_oauth_grants (org_username, kody_id);
