-- Entitlement enforcement primitives.
--
-- The nullable users.plan column is added by migration
-- 0046-invites-email-verification.sql (NULL means legacy/unlimited).
-- Plan values are validated in code against the plan names defined in
-- packages/worker/src/entitlements/plans.ts, so new plans do not require a
-- schema migration.

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
