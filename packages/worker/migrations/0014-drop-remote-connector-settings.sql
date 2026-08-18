-- Drop retired remote connector settings. Home automation and other
-- outbound tools now use normal MCP servers (`kody.mcp[...]`).
DROP INDEX IF EXISTS idx_remote_connector_settings_ref_enabled;
DROP TABLE IF EXISTS remote_connector_settings;
