-- Last classified OAuth refresh outcome on a connection. Cleared on a
-- successful refresh or token persist. Not part of upsertIntegrationConnection
-- ON CONFLICT so a config save cannot wipe or invent health.
ALTER TABLE user_integrations ADD COLUMN auth_failed_at TEXT;
ALTER TABLE user_integrations ADD COLUMN auth_failed_reason TEXT;
ALTER TABLE user_integrations ADD COLUMN auth_failed_provider_error TEXT;
ALTER TABLE user_integrations ADD COLUMN auth_failed_provider_description TEXT;
ALTER TABLE user_integrations ADD COLUMN auth_failed_http_status INTEGER;
ALTER TABLE user_integrations ADD COLUMN auth_failed_reconnectable INTEGER
	CHECK (auth_failed_reconnectable IN (0, 1));
