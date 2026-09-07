-- Durable usage-campaign state machine and send ledger. One row per user.
-- Backfill is out of scope: the hourly sweep seeds current state without
-- mailing. Campaign mail starts on verify (VerifiedNoMcp send 1) or on a
-- later state transition. Kit stays exist-only tags; this is not a Kit drip.
-- IF NOT EXISTS: this PR's preview D1 already created these tables when
-- the file was numbered 0047 then 0049-user-usage-campaigns.sql. Main took
-- 0049 for 0049-drop-integration-secret-names.sql, so this file is 0050.
-- Preview already has users.tips_emails_opted_out_at from that old 0049
-- filename; production never got that column. Opt-out now lives on
-- user_tips_email_opt_outs so this apply is idempotent on preview.

CREATE TABLE IF NOT EXISTS user_tips_email_opt_outs (
	user_id TEXT PRIMARY KEY NOT NULL,
	opted_out_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_usage_campaigns (
	user_id TEXT PRIMARY KEY NOT NULL,
	state TEXT NOT NULL,
	entered_at TEXT NOT NULL,
	send_count INTEGER NOT NULL DEFAULT 0,
	last_sent_at TEXT,
	last_evaluated_at TEXT NOT NULL,
	origin TEXT NOT NULL CHECK (origin IN ('seed', 'event')),
	cooling_terminal INTEGER NOT NULL DEFAULT 0 CHECK (cooling_terminal IN (0, 1)),
	ever_activated INTEGER NOT NULL DEFAULT 0,
	first_activated_at TEXT,
	advocate_sent_at TEXT,
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

CREATE UNIQUE INDEX IF NOT EXISTS user_usage_campaign_sends_advocate_unique
	ON user_usage_campaign_sends(user_id)
	WHERE template = 'advocate_referral_testimonial';
