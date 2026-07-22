-- Rename stored plan sentinel 'unlimited' → 'max' on users.plan and
-- invites.plan.
--
-- Exact-match data rename only. Does not touch users.stripe_plan, unknown
-- plan strings, table schemas, nullability, or DEFAULT values. Concurrent
-- Stripe/billing fields stay as stored.
--
-- Fail-closed: residual 'unlimited' values abort the migration (D1 wraps each
-- file in a transaction and rolls it back).

UPDATE users SET plan = 'max' WHERE plan = 'unlimited';
UPDATE invites SET plan = 'max' WHERE plan = 'unlimited';

-- __migration_assertions intentionally uses CHECK (0) as an unreachable trap.
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'users.plan still contains unlimited after max rename; aborting 0082.'
WHERE EXISTS (SELECT 1 FROM users WHERE plan = 'unlimited');

INSERT INTO __migration_assertions (message)
SELECT 'invites.plan still contains unlimited after max rename; aborting 0082.'
WHERE EXISTS (SELECT 1 FROM invites WHERE plan = 'unlimited');

DROP TABLE __migration_assertions;
