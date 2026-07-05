-- Per-user, per-metric, per-month usage counters written by recordUsage()
-- (packages/worker/src/usage/record-usage.ts). Analytics Engine keeps the
-- raw event stream for analysis; this table is the cheap read path for
-- future quota enforcement.
CREATE TABLE usage_rollups (
	user_id TEXT NOT NULL,
	metric TEXT NOT NULL,
	month TEXT NOT NULL,
	event_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	total_duration_ms INTEGER NOT NULL DEFAULT 0,
	total_cpu_ms INTEGER NOT NULL DEFAULT 0,
	total_bytes INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, metric, month)
);

CREATE INDEX idx_usage_rollups_user_month
ON usage_rollups(user_id, month);
