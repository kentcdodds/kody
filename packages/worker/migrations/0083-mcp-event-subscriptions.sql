-- MCP Events extension (draft, webhook delivery only) subscriptions.
-- One row per subscription key (user, OAuth client, event name, canonical
-- arguments, callback URL); `id` is a deterministic hash of that key, so the
-- primary key is the uniqueness constraint. Secrets are client-supplied
-- Standard Webhooks `whsec_` values, stored encrypted. `refresh_before` is
-- the granted expiry; the server always grants a finite TTL.
CREATE TABLE mcp_event_subscriptions (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	oauth_client_id TEXT NOT NULL,
	connection_profile_name TEXT,
	event_name TEXT NOT NULL,
	arguments_json TEXT NOT NULL,
	callback_url TEXT NOT NULL,
	secret_encrypted TEXT NOT NULL,
	previous_secret_encrypted TEXT,
	previous_secret_expires_at TEXT,
	refresh_before TEXT,
	verified_at TEXT,
	active INTEGER NOT NULL DEFAULT 1,
	last_delivery_at TEXT,
	last_error TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX idx_mcp_event_subscriptions_user_event
ON mcp_event_subscriptions(user_id, event_name);

CREATE INDEX idx_mcp_event_subscriptions_oauth_client
ON mcp_event_subscriptions(oauth_client_id);
