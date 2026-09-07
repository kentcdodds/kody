-- first_activated_at / advocate_sent_at now land in
-- 0050-user-usage-campaigns.sql. Keep the unique index here so a preview
-- D1 that already applied the old 0051 filename still converges.

CREATE UNIQUE INDEX IF NOT EXISTS user_usage_campaign_sends_advocate_unique
	ON user_usage_campaign_sends(user_id)
	WHERE template = 'advocate_referral_testimonial';
