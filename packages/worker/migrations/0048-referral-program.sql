-- Uncapped referral program. Attribution is write-once at signup via
-- ?ref=<username>. Reward is one Standard month (30 days) for both
-- parties after the referee's first qualifying paid Stripe invoice.
-- referral_standard_credit_expires_at stacks without a cap.

ALTER TABLE users ADD COLUMN referral_standard_credit_expires_at TEXT;

CREATE TABLE referrals (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	referrer_stable_user_id TEXT NOT NULL,
	referee_stable_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'rewarded', 'rejected')),
	rewarded_at TEXT,
	reward_invoice_id TEXT,
	reject_reason TEXT,
	held_invoice_id TEXT,
	held_period_end_at TEXT
);

CREATE UNIQUE INDEX idx_referrals_referee
	ON referrals(referee_stable_user_id);

CREATE INDEX idx_referrals_referrer
	ON referrals(referrer_stable_user_id);

CREATE UNIQUE INDEX idx_referrals_reward_invoice
	ON referrals(reward_invoice_id)
	WHERE reward_invoice_id IS NOT NULL;
