-- Auto-fetched favicons for user-added MCP servers. Assets live in
-- COMMUNITY_ASSETS under content-hashed keys. SVG is rasterized; ICO
-- is accepted only when it embeds a PNG. favicon_source_host records
-- the registrable domain last used so a changed server URL can re-fetch.
ALTER TABLE mcp_server_settings ADD COLUMN logo_key TEXT;

ALTER TABLE mcp_server_settings ADD COLUMN logo_content_type TEXT;

ALTER TABLE mcp_server_settings ADD COLUMN logo_source TEXT
	CHECK (logo_source IN ('favicon'));

ALTER TABLE mcp_server_settings ADD COLUMN favicon_source_host TEXT;
