PRAGMA defer_foreign_keys = ON;

CREATE TABLE jobs_v3 (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	code TEXT NOT NULL,
	server_code TEXT,
	server_code_id TEXT,
	method_name TEXT,
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
	last_run_error TEXT,
	last_duration_ms INTEGER,
	next_run_at TEXT NOT NULL,
	run_count INTEGER NOT NULL DEFAULT 0,
	success_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	run_history_json TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO jobs_v3 (
	id,
	user_id,
	name,
	code,
	server_code,
	server_code_id,
	method_name,
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
	CASE
		WHEN code IS NOT NULL AND TRIM(code) != '' THEN code
		WHEN server_code IS NOT NULL AND TRIM(server_code) != '' THEN
			'async (params) => await job.call(''' ||
			REPLACE(COALESCE(NULLIF(TRIM(method_name), ''), 'run'), '''', '''''') ||
			''', params)'
	END AS code,
	server_code,
	server_code_id,
	CASE
		WHEN server_code IS NOT NULL AND TRIM(server_code) != '' THEN
			COALESCE(NULLIF(TRIM(method_name), ''), 'run')
		ELSE NULL
	END AS method_name,
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
FROM jobs;

DROP TABLE jobs;

ALTER TABLE jobs_v3 RENAME TO jobs;

CREATE INDEX idx_jobs_user_next_run_at
	ON jobs(user_id, enabled, kill_switch_enabled, next_run_at);

CREATE INDEX idx_jobs_user_name
	ON jobs(user_id, name);

PRAGMA defer_foreign_keys = OFF;
