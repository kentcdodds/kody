-- Initial schema for the dedicated jobs D1 database (ADR 0016). Mirrors the
-- `jobs` and `archived_job_artifacts` schema in the main worker's APP_DB
-- (packages/worker/migrations/0001-squashed-init.sql plus later index
-- migrations) at the time of extraction. Production data moves via the
-- bounded export/import described in
-- docs/contributing/architecture/jobs-worker-migration-runbook.md; the old
-- APP_DB tables are dropped by a later APP_DB migration after the flip.

CREATE TABLE jobs (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	source_id TEXT NOT NULL,
	published_commit TEXT,
	repo_check_policy_json TEXT,
	storage_id TEXT NOT NULL,
	params_json TEXT,
	schedule_json TEXT NOT NULL,
	timezone TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	kill_switch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch_enabled IN (0, 1)),
	caller_context_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_run_at TEXT,
	last_run_status TEXT,
	next_run_at TEXT NOT NULL,
	preserved INTEGER NOT NULL DEFAULT 0 CHECK (preserved IN (0, 1)),
	claim_token TEXT,
	running_since TEXT,
	lease_expires_at TEXT,
	claimed_scheduled_for TEXT,
	retry_scheduled_for TEXT,
	retry_count INTEGER NOT NULL DEFAULT 0,
	last_completed_scheduled_for TEXT,
	expires_at TEXT
);

CREATE INDEX idx_jobs_user_next_run_at
	ON jobs(user_id, enabled, kill_switch_enabled, next_run_at);
CREATE INDEX idx_jobs_user_name
	ON jobs(user_id, name);
CREATE INDEX idx_jobs_source_id
	ON jobs(source_id);
CREATE INDEX idx_jobs_retention_candidates
	ON jobs(preserved, enabled, last_run_at, updated_at);
CREATE INDEX idx_jobs_user_enabled_expires_next_run
	ON jobs(user_id, enabled, kill_switch_enabled, expires_at, next_run_at);

CREATE TABLE archived_job_artifacts (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL UNIQUE,
	user_id TEXT NOT NULL,
	source_id TEXT NOT NULL,
	published_commit TEXT NOT NULL,
	storage_id TEXT NOT NULL,
	retain_until TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_archived_job_artifacts_user_id
	ON archived_job_artifacts(user_id);
CREATE INDEX idx_archived_job_artifacts_retain_until
	ON archived_job_artifacts(retain_until);

-- Small operational key/value state owned by the jobs worker (for example
-- the schedule-watchdog alert cooldown, previously stored in the main
-- worker's BUNDLE_ARTIFACTS_KV).
CREATE TABLE jobs_worker_state (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
