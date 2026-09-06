-- Write-once first successful MCP `search` stamp. Onboarding Step 2 waits on
-- this (or an existing access win) instead of reconstructing from mcp-event
-- logs, which are not request-path readable.

ALTER TABLE users ADD COLUMN first_search_at TEXT;
