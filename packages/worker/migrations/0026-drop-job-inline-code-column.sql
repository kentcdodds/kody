PRAGMA defer_foreign_keys = ON;

CREATE TABLE jobs_v2 (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	source_id TEXT NOT NULL,
	published_commit TEXT NOT NULL,
	storage_id TEXT NOT NULL,
	params_json TEXT,
	schedule_json TEXT NOT NULL,
	timezone TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	kill_switch_enabled INTEGER NOT NULL DEFAULT 0,
	caller_context_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_run_at TEXT,
	last_run_status TEXT,
	last_run_error TEXT,
	last_duration_ms INTEGER,
	next_run_at TEXT NOT NULL,
	run_count INTEGER NOT NULL DEFAULT 0,
	success_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	run_history_json TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO jobs_v2 (
	id,
	user_id,
	name,
	source_id,
	published_commit,
	storage_id,
	params_json,
	schedule_json,
	timezone,
	enabled,
	kill_switch_enabled,
	caller_context_json,
	created_at,
	updated_at,
	last_run_at,
	last_run_status,
	last_run_error,
	last_duration_ms,
	next_run_at,
	run_count,
	success_count,
	error_count,
	run_history_json
)
SELECT
	id,
	user_id,
	name,
	source_id,
	published_commit,
	storage_id,
	params_json,
	schedule_json,
	timezone,
	enabled,
	kill_switch_enabled,
	caller_context_json,
	created_at,
	updated_at,
	last_run_at,
	last_run_status,
	last_run_error,
	last_duration_ms,
	next_run_at,
	run_count,
	success_count,
	error_count,
	run_history_json
FROM jobs
WHERE source_id IS NOT NULL
  AND published_commit IS NOT NULL;

DROP TABLE jobs;

ALTER TABLE jobs_v2 RENAME TO jobs;

CREATE INDEX IF NOT EXISTS idx_jobs_user_next_run
	ON jobs(user_id, next_run_at);

CREATE INDEX IF NOT EXISTS idx_jobs_user_enabled_next_run
	ON jobs(user_id, enabled, kill_switch_enabled, next_run_at);

CREATE INDEX IF NOT EXISTS idx_jobs_source_id
	ON jobs(source_id);

PRAGMA defer_foreign_keys = OFF;
