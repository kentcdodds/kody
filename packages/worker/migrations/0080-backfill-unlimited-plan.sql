-- Stage 1: materialize stored NULL plans as the explicit sentinel 'unlimited'
-- on users.plan and invites.plan.
--
-- Behavior invariant: no existing account gains new ordinary entitlement
-- enforcement. `unlimited` is a first-class plan name; ordinary resources stay
-- uncapped, email resources keep the historical nullPlanEmailFallbackLimits
-- backstops, and concurrent workflows keep the env global backstop. Residual
-- stored NULL and unknown plan strings still dual-read as fail-open until
-- stage 2. Stripe never downgrades a stored-NULL account into enforcement, so
-- this migration intentionally does not touch users.stripe_plan.
--
-- Stage 1 does not make plan NOT NULL and does not rebuild tables.
--
-- Fail-closed: residual NULLs abort the migration (D1 wraps each file in a
-- transaction and rolls it back).

UPDATE users SET plan = 'unlimited' WHERE plan IS NULL;
UPDATE invites SET plan = 'unlimited' WHERE plan IS NULL;

-- __migration_assertions intentionally uses CHECK (0) as an unreachable trap.
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'users.plan still contains NULL after unlimited backfill; aborting 0080.'
WHERE EXISTS (SELECT 1 FROM users WHERE plan IS NULL);

INSERT INTO __migration_assertions (message)
SELECT 'invites.plan still contains NULL after unlimited backfill; aborting 0080.'
WHERE EXISTS (SELECT 1 FROM invites WHERE plan IS NULL);

DROP TABLE __migration_assertions;
