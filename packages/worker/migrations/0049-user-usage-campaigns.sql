-- Durable usage-campaign state machine and send ledger. One row per user.
-- Backfill is out of scope: the hourly sweep seeds current state without
-- mailing. Campaign mail starts on verify (VerifiedNoMcp send 1) or on a
-- later state transition. Kit stays exist-only tags; this is not a Kit drip.
-- IF NOT EXISTS: this PR's preview D1 already created these tables when
-- the file was numbered 0047-user-usage-campaigns.sql.

CREATE TABLE IF NOT EXISTS user_usage_campaigns (
	user_id TEXT PRIMARY KEY NOT NULL,
	state TEXT NOT NULL,
	entered_at TEXT NOT NULL,
	send_count INTEGER NOT NULL DEFAULT 0,
	last_sent_at TEXT,
	last_evaluated_at TEXT NOT NULL,
	origin TEXT NOT NULL CHECK (origin IN ('seed', 'event')),
	cooling_terminal INTEGER NOT NULL DEFAULT 0 CHECK (cooling_terminal IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_usage_campaigns_evaluated
	ON user_usage_campaigns(last_evaluated_at, user_id);

CREATE TABLE IF NOT EXISTS user_usage_campaign_sends (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	state TEXT NOT NULL,
	template TEXT NOT NULL,
	send_index INTEGER NOT NULL,
	sent_at TEXT NOT NULL,
	UNIQUE (user_id, state, send_index)
);

CREATE INDEX IF NOT EXISTS idx_user_usage_campaign_sends_user
	ON user_usage_campaign_sends(user_id);
