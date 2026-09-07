-- Durable usage-campaign state machine and send ledger. One row per user.
-- Backfill is out of scope: the hourly sweep seeds current state without
-- mailing. Campaign mail starts on verify (VerifiedNoMcp send 1) or on a
-- later state transition. Kit stays exist-only tags; this is not a Kit drip.
-- IF NOT EXISTS: this PR's preview D1 already created these tables when
-- the file was numbered 0047-user-usage-campaigns.sql.
--
-- tips_emails_opted_out_at shipped on this PR as
-- 0048-users-tips-emails-opted-out-at.sql before main took 0048 for the
-- referral program. Check-migrations cannot keep both 0048 files. Preview
-- already applied the old 0048-tips name and this 0049 file; production
-- gets the column the first time 0049 runs.

ALTER TABLE users ADD COLUMN tips_emails_opted_out_at TEXT;

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
