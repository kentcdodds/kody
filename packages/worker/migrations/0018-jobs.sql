CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	code TEXT,
	server_code TEXT,
	server_code_id TEXT,
	method_name TEXT,
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

CREATE INDEX IF NOT EXISTS idx_jobs_user_next_run
	ON jobs(user_id, next_run_at);

CREATE INDEX IF NOT EXISTS idx_jobs_user_enabled_next_run
	ON jobs(user_id, enabled, kill_switch_enabled, next_run_at);
