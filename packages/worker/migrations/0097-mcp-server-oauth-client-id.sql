-- Pre-registered OAuth client for a user-added MCP server. Only the public
-- client id lives here, so the settings page can show the client as
-- configured. The client secret is sealed in the McpClientHub Durable Object
-- next to the OAuth tokens it is used to obtain, and never stored in D1.
--
-- Reverse:
--   ALTER TABLE mcp_server_settings DROP COLUMN oauth_client_id;

ALTER TABLE mcp_server_settings ADD COLUMN oauth_client_id TEXT;
