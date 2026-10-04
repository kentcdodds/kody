-- Recoverable retry for signup welcome credits (#2722).
--
-- Creation-time grants still swallow D1 errors so signup succeeds. New
-- person-account inserts set `signup_welcome_credits_pending = 1` in the same
-- write, then clear it after a confirmed grant. Login and wallet-touch
-- reconcile only when the flag is set. Default 0 means pre-existing accounts
-- are not backfilled. The ledger id `signup_welcome:{stableUserId}` stays
-- unique so retries never double-grant.

ALTER TABLE users ADD COLUMN signup_welcome_credits_pending INTEGER NOT NULL DEFAULT 0
	CHECK (signup_welcome_credits_pending IN (0, 1));
