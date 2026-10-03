-- Daily billable usage units attributed to a package (or Ad hoc when
-- package_id is empty). Recomputed hourly from Analytics Engine alongside
-- usage_rollups; local/dev without AE upserts on each recordUsage write.
-- Customer debit meters only: Worker compute (dynamic_worker_day) and
-- StorageRunner rows read. Never RunLog / platform rows.
CREATE TABLE IF NOT EXISTS usage_attribution_daily (
	user_id TEXT NOT NULL,
	day TEXT NOT NULL,
	package_id TEXT NOT NULL,
	meter TEXT NOT NULL,
	units REAL NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (user_id, day, package_id, meter)
);

CREATE INDEX IF NOT EXISTS idx_usage_attribution_daily_user_month
ON usage_attribution_daily(user_id, day);
