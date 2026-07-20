-- Stripe subscription billing columns on users.
-- stripe_plan is validated in code against packages/worker/src/entitlements/plans.ts.
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN stripe_plan TEXT;
ALTER TABLE users ADD COLUMN stripe_plan_refreshed_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_id
ON users(stripe_customer_id)
WHERE stripe_customer_id IS NOT NULL;
