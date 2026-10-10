-- Daily usage per connection: which credential (MCP agent, CLI, API token)
-- or Automation each metered unit came through, from Analytics Engine blob12
-- (`<credential kind>:<holder person id>:<credential id>`). The hourly usage
-- aggregation lane rewrites yesterday and today with absolute units and prunes
-- rows older than 14 days. Local/dev without Analytics Engine upserts on each
-- recordUsage write. Empty credential_kind is unattributed (before tracking).
CREATE TABLE IF NOT EXISTS usage_connection_daily (
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	credential_kind TEXT NOT NULL,
	holder_user_id TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	event_type TEXT NOT NULL,
	units REAL NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (
		user_id, day, credential_kind, holder_user_id, credential_id,
		package_id, event_type
	)
);

CREATE INDEX IF NOT EXISTS idx_usage_connection_daily_day
ON usage_connection_daily(day);
