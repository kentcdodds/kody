-- Named connection profiles: experimenter-gated weaker MCP/API credentials.
-- A profile is an allowlist of generic resource grants (type, id, actions).
-- Absent profile = unlimited (today's connection). Named profile with zero
-- grants = see and run nothing. V1 accepts only resource_type package and
-- actions read/execute; write and other types are rejected at write time.
-- Grants live as JSON so later resource types and write do not need a new model.
CREATE TABLE connection_profiles (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	grants_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX idx_connection_profiles_user_name
ON connection_profiles(user_id, name);

CREATE INDEX idx_connection_profiles_user_id
ON connection_profiles(user_id);

-- Optional profile binding for API tokens (same grant rules as MCP).
ALTER TABLE api_tokens ADD COLUMN profile_name TEXT;
