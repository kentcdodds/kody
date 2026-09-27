-- Admin-owned prepaid credit eligibility (#2617 follow-up).
--
-- `users.stripe_credits_eligible` is a Stripe projection that every plan
-- refresh overwrites, so it cannot carry a manual decision. Admins set
-- `admin_credits_eligible` through `adminCreditEligibilitySet`; an effective
-- `pro` plan with either flag gets the credit wallet. Stripe never writes
-- this column, and it does not let an account buy credits or auto-refill
-- (those still require the purchasable Pro subscription).

ALTER TABLE users ADD COLUMN admin_credits_eligible INTEGER NOT NULL DEFAULT 0
	CHECK (admin_credits_eligible IN (0, 1));
