-- Teams P3 expand: additive actor / attribution columns. Ownership stays on
-- existing user_id columns (the org id for migrated orgs). Backfill is 0089.

ALTER TABLE webhook_endpoints ADD COLUMN created_by_user_id TEXT;

ALTER TABLE user_integrations ADD COLUMN connected_by_user_id TEXT;

ALTER TABLE mcp_server_settings ADD COLUMN connected_by_user_id TEXT;

ALTER TABLE usage_attribution_daily ADD COLUMN actor_user_id TEXT;
ALTER TABLE usage_attribution_daily ADD COLUMN automation_source TEXT
	CHECK (
		automation_source IS NULL
		OR automation_source IN ('webhook', 'schedule', 'email', 'event')
	);

ALTER TABLE usage_rollups ADD COLUMN actor_user_id TEXT;
ALTER TABLE usage_rollups ADD COLUMN automation_source TEXT
	CHECK (
		automation_source IS NULL
		OR automation_source IN ('webhook', 'schedule', 'email', 'event')
	);

ALTER TABLE durable_object_duration_daily ADD COLUMN actor_user_id TEXT;
ALTER TABLE durable_object_duration_daily ADD COLUMN automation_source TEXT
	CHECK (
		automation_source IS NULL
		OR automation_source IN ('webhook', 'schedule', 'email', 'event')
	);
