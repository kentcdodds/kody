-- Recoverable retry for signup welcome credits (#2722).
--
-- Creation-time grants still swallow D1 errors so signup succeeds. When a
-- grant fails, `signup_welcome_credits_pending` is set so the next login or
-- wallet touch can retry. Default 0 means pre-existing accounts are not
-- backfilled; only accounts whose grant failed after this ships are marked.
-- The ledger id `signup_welcome:{stableUserId}` stays unique so retries never
-- double-grant.

ALTER TABLE users ADD COLUMN signup_welcome_credits_pending INTEGER NOT NULL DEFAULT 0
	CHECK (signup_welcome_credits_pending IN (0, 1));
