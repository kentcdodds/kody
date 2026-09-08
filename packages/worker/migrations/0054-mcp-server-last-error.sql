-- Durable, sanitized lastError for incomplete MCP OAuth settle (post-IdP).
-- Live hub connectionError is ephemeral; this column survives reloads so
-- /account/mcp-servers can show the failure under Status.
ALTER TABLE mcp_server_settings ADD COLUMN last_error TEXT;
