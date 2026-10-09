-- Prepaid credit wallet for the purchasable Pro plan (#2617).
--
-- `users.stripe_credits_eligible` is the Stripe-derived projection of
-- "the subscription granting stripe_plan uses the configured Pro price"
-- (STRIPE_PRO_PRICE_ID / STRIPE_PRO_YEARLY_PRICE_ID). Retired Standard and
-- Pro prices at the same list price stay 0. Written by every Stripe plan
-- refresh next to stripe_price_id; defaults to 0 so no account changes
-- until its next refresh.
--
-- Balances are integer micro-USD. `credit_ledger_entries` is the
-- append-only history (top-ups, auto-refills, admin grants, debits).
-- `stripe_reference` is unique so a replayed checkout session or payment
-- intent cannot credit twice; debit ids are deterministic per starting
-- position so an overlapping debit run cannot charge twice.
-- `credit_debit_progress` records how many billable units above the
-- include each meter has already accounted for this month. `meter` is
-- open TEXT so CPU (then storage/email) can join without a rebuild.
-- `credit_debit_cursor` is the platform-owned keyset position of the
-- bounded hourly debit sweep (last processed wallet user_id), so every
-- wallet is reached across runs.

ALTER TABLE users ADD COLUMN stripe_credits_eligible INTEGER NOT NULL DEFAULT 0
	CHECK (stripe_credits_eligible IN (0, 1));

CREATE TABLE credit_wallets (
	user_id TEXT PRIMARY KEY NOT NULL,
	balance_micro_usd INTEGER NOT NULL DEFAULT 0,
	auto_refill_enabled INTEGER NOT NULL DEFAULT 0
		CHECK (auto_refill_enabled IN (0, 1)),
	auto_refill_threshold_cents INTEGER,
	auto_refill_amount_cents INTEGER,
	auto_refill_monthly_cap_cents INTEGER,
	auto_refill_payment_method_id TEXT,
	auto_refill_failed_at TEXT,
	notify_auto_refilled INTEGER NOT NULL DEFAULT 1
		CHECK (notify_auto_refilled IN (0, 1)),
	notify_monthly_cap INTEGER NOT NULL DEFAULT 1
		CHECK (notify_monthly_cap IN (0, 1)),
	notify_low_balance INTEGER NOT NULL DEFAULT 1
		CHECK (notify_low_balance IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE credit_ledger_entries (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL
		CHECK (kind IN ('top_up', 'auto_refill', 'admin_grant', 'debit')),
	amount_micro_usd INTEGER NOT NULL,
	meter TEXT,
	month TEXT,
	units INTEGER,
	stripe_reference TEXT,
	granted_by_user_id TEXT,
	note TEXT,
	created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_credit_ledger_entries_stripe_reference
	ON credit_ledger_entries (stripe_reference)
	WHERE stripe_reference IS NOT NULL;

CREATE INDEX idx_credit_ledger_entries_user_created
	ON credit_ledger_entries (user_id, created_at);

CREATE TABLE credit_debit_progress (
	user_id TEXT NOT NULL,
	month TEXT NOT NULL,
	meter TEXT NOT NULL,
	accounted_units INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, month, meter)
);

CREATE TABLE credit_debit_cursor (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	position TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT INTO credit_debit_cursor (singleton, position) VALUES (1, '');
