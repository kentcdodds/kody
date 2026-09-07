-- Sticky first-activation stamp and one-shot advocate send marker.
-- first_activated_at does not reset when Activated becomes Paid.
-- advocate_sent_at plus the partial unique index cap the referral /
-- testimonial mail at one forever, across Activated and Paid.

ALTER TABLE user_usage_campaigns ADD COLUMN first_activated_at TEXT;
ALTER TABLE user_usage_campaigns ADD COLUMN advocate_sent_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS user_usage_campaign_sends_advocate_unique
	ON user_usage_campaign_sends(user_id)
	WHERE template = 'advocate_referral_testimonial';
