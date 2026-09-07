-- Catch-up for D1s that already applied the old 0050-user-usage-campaigns.sql
-- filename before user_tips_email_opt_outs was written into that file.
-- Fresh applies create the table in 0050. IF NOT EXISTS makes this a no-op.

CREATE TABLE IF NOT EXISTS user_tips_email_opt_outs (
	user_id TEXT PRIMARY KEY NOT NULL,
	opted_out_at TEXT NOT NULL
);
