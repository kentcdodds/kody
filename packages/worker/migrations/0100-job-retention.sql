-- Job auto-cleanup / retention: per-job preserve flag + account retention windows.
-- Preserved jobs and package-owned jobs are never swept. Account columns are
-- nullable so NULL means "use platform defaults" (14 / 60 / 90 days).

ALTER TABLE jobs ADD COLUMN preserved INTEGER NOT NULL DEFAULT 0
	CHECK (preserved IN (0, 1));

ALTER TABLE users ADD COLUMN job_retention_success_once_days INTEGER
	CHECK (
		job_retention_success_once_days IS NULL
		OR (
			job_retention_success_once_days >= 1
			AND job_retention_success_once_days <= 365
		)
	);

ALTER TABLE users ADD COLUMN job_retention_failed_once_days INTEGER
	CHECK (
		job_retention_failed_once_days IS NULL
		OR (
			job_retention_failed_once_days >= 1
			AND job_retention_failed_once_days <= 365
		)
	);

ALTER TABLE users ADD COLUMN job_retention_disabled_recurring_days INTEGER
	CHECK (
		job_retention_disabled_recurring_days IS NULL
		OR (
			job_retention_disabled_recurring_days >= 1
			AND job_retention_disabled_recurring_days <= 365
		)
	);

CREATE INDEX IF NOT EXISTS idx_jobs_retention_candidates
	ON jobs(preserved, enabled, last_run_at, updated_at);
