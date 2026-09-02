-- Global time-column index for the hourly retention prune, which orders the
-- whole table by last_used_at. The existing (user_id, last_used_at) index
-- serves per-user popularity reads but cannot serve that cross-user scan.
CREATE INDEX IF NOT EXISTS idx_agent_package_conversation_uses_last_used
	ON agent_package_conversation_uses (last_used_at);
