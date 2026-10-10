-- Teams billing: a checkout promo code is claimed once per person, across
-- every org they bill. Each org is its own Stripe customer, so Stripe's own
-- first-time rule is per org; Kody records the claim when the discounted
-- Checkout Session completes and refuses later promo checkouts by that person.

CREATE TABLE IF NOT EXISTS billing_promo_claims (
	user_id TEXT PRIMARY KEY NOT NULL,
	promotion_code_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('reserved', 'claimed')),
	checkout_session_id TEXT,
	reserved_at TEXT NOT NULL,
	claimed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_billing_promo_claims_session
	ON billing_promo_claims (checkout_session_id);
