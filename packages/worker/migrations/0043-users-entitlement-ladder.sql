-- Durable entitlement ladder for the public Standard/Pro pricing cut.
-- `public` is the live pricing-page table. `legacy` keeps the pre-cut
-- Standard/Pro ceilings for accounts that already had continuous paid
-- access (Stripe standard/pro, or a manual Pro grant) at backfill time.
-- Cancel + resubscribe writes `public`; the marker is never inferred
-- from join date.

ALTER TABLE users ADD COLUMN entitlement_ladder TEXT NOT NULL DEFAULT 'public'
	CHECK (entitlement_ladder IN ('public', 'legacy'));

UPDATE users
SET entitlement_ladder = 'legacy'
WHERE deleting_at IS NULL
	AND (
		stripe_plan IN ('standard', 'pro')
		OR plan = 'pro'
	);
