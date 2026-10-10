-- Teams billing: a checkout promo code is claimed once per person, across
-- every org they bill. Each org is its own Stripe customer, so Stripe's own
-- first-time rule is per org; Kody records the claim when the discounted
-- Checkout Session completes and refuses later promo checkouts by that person.

CREATE TABLE IF NOT EXISTS billing_promo_claims (
	user_id TEXT PRIMARY KEY NOT NULL,
	promotion_code_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	checkout_session_id TEXT NOT NULL,
	claimed_at TEXT NOT NULL
);
