-- Associate invites with a signup plan.
-- Plan values are validated in code against the plan names defined in
-- packages/worker/src/entitlements/plans.ts (same convention as users.plan).
ALTER TABLE invites ADD COLUMN plan TEXT DEFAULT NULL;
