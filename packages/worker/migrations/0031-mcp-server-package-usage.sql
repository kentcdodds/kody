-- MCP client servers can be limited to listed saved packages, matching
-- user_integrations.usage_mode. 'any' is execute plus every package;
-- 'packages' is only the listed ids (execute is denied). New servers
-- default to 'any'. Tokens stay in the hub DO.
ALTER TABLE mcp_server_settings ADD COLUMN usage_mode TEXT NOT NULL DEFAULT 'any'
	CHECK (usage_mode IN ('any', 'packages'));

ALTER TABLE mcp_server_settings ADD COLUMN allowed_packages_json TEXT NOT NULL DEFAULT '[]';
