-- Distinct agent-facing (MCP execute) package uses per conversation.
-- Source of truth for the packages-first popularity hint in MCP server
-- instructions. Ranked by unique conversation_id count over a rolling window;
-- not a hot usage_rollups widen.
-- conversation_id stores SHA-256 hex of the MCP conversation id (cardinality
-- only; not reversible to the raw id).
CREATE TABLE agent_package_conversation_uses (
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	first_used_at TEXT NOT NULL,
	last_used_at TEXT NOT NULL,
	PRIMARY KEY (user_id, package_id, conversation_id)
);

CREATE INDEX idx_agent_package_conversation_uses_user_last_used
ON agent_package_conversation_uses(user_id, last_used_at);
