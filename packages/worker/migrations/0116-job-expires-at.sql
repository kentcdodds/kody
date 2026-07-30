-- Optional UTC ISO expiry for ad hoc / repo-backed scheduled jobs.
-- When now >= expires_at, the scheduler skips the job and auto-disables it
-- (enabled = 0). Retention / preserved semantics stay separate: expires_at
-- stops scheduling; preserved only skips auto-deletion.

ALTER TABLE jobs ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_user_enabled_expires_next_run
	ON jobs(user_id, enabled, kill_switch_enabled, expires_at, next_run_at);
