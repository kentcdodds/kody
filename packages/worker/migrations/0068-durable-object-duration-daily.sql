-- Per-user Durable Object active time from Cloudflare analytics.
--
-- The hourly durable_object_duration_attribution lane reads Cloudflare's
-- per-object `activeTime` (GraphQL durableObjectsPeriodicGroups) for recent
-- UTC days and maps each object id back to its owner by recomputing
-- idFromName for the frozen per-user names. Rows are absolute per day, so
-- reruns overwrite rather than add. GB-s is derived at read time (active
-- seconds x 0.128 GB); this is an estimate of the duration line, not an
-- invoice amount.
CREATE TABLE durable_object_duration_daily (
	user_id TEXT NOT NULL,
	do_class TEXT NOT NULL,
	day TEXT NOT NULL,
	active_ms INTEGER NOT NULL,
	object_count INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, do_class, day)
);

CREATE INDEX idx_durable_object_duration_daily_day
	ON durable_object_duration_daily (day);

-- Fleet-wide attribution coverage per UTC day: how much Cloudflare-reported
-- active time mapped to a user versus stayed unattributed (MCP sessions,
-- JobManager, discarded repo sessions, platform singletons).
CREATE TABLE durable_object_duration_coverage_daily (
	day TEXT PRIMARY KEY,
	total_active_ms INTEGER NOT NULL,
	attributed_active_ms INTEGER NOT NULL,
	object_count INTEGER NOT NULL,
	attributed_object_count INTEGER NOT NULL,
	truncated INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL
);
