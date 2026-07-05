-- Per-user plans and entitlement enforcement primitives.
--
-- users.plan is a nullable text column: NULL means legacy/unlimited (no
-- enforcement), otherwise one of the plan names defined in
-- packages/worker/src/entitlements/plans.ts. Values are validated in code so
-- new plans do not require a schema migration.
--
-- Coordination note: a parallel branch (invite signup) may add the same
-- users.plan column in migration 0046. If that migration lands first, this
-- ALTER TABLE must be removed at rebase time. Never let two migrations add
-- the same column.
ALTER TABLE users ADD COLUMN plan TEXT;

-- Daily counters for rate-style entitlements (for example email sends per
-- day). Row-count limits (packages, jobs, secrets, repo sessions) are counted
-- directly from their source tables at the enforcement point and do not use
-- this table.
CREATE TABLE IF NOT EXISTS entitlement_daily_counters (
	user_id TEXT NOT NULL,
	resource TEXT NOT NULL,
	day TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, resource, day)
);
