-- Admin per-org entitlement limit overrides: one row per (org, limit key).
-- The single source of truth; entitlement resolution applies active rows on
-- top of the plan limit (the larger value wins). `limit_value` NULL means
-- unlimited. `expires_at` NULL means no expiry. `limit_key` is validated in
-- code (`limitOverrideKeys` in universal/plans.ts) so adding a key needs no
-- table rebuild; unknown keys are ignored on read.
CREATE TABLE IF NOT EXISTS org_limit_overrides (
	org_id TEXT NOT NULL,
	limit_key TEXT NOT NULL,
	limit_value INTEGER CHECK (limit_value IS NULL OR limit_value >= 0),
	reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
	expires_at TEXT,
	set_by_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (org_id, limit_key)
);
