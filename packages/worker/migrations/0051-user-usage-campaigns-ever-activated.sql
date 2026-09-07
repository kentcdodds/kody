-- ever_activated now lands in 0050-user-usage-campaigns.sql so a renamed
-- preview apply does not ADD COLUMN onto a table that already has it.

CREATE INDEX IF NOT EXISTS idx_user_usage_campaigns_evaluated
	ON user_usage_campaigns(last_evaluated_at, user_id);
