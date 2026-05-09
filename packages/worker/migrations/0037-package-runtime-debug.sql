CREATE TABLE IF NOT EXISTS package_runtime_runs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	package_kody_id TEXT NOT NULL,
	source_id TEXT,
	published_commit TEXT,
	surface TEXT NOT NULL CHECK (
		surface IN (
			'export',
			'subscription',
			'app_fetch',
			'app_realtime',
			'service',
			'job',
			'workflow',
			'retriever'
		)
	),
	name TEXT,
	status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
	started_at TEXT NOT NULL,
	finished_at TEXT,
	duration_ms INTEGER,
	error_name TEXT,
	error_message TEXT,
	storage_id TEXT,
	job_id TEXT,
	workflow_id TEXT,
	invocation_id TEXT,
	session_id TEXT,
	idempotency_key TEXT,
	parent_run_id TEXT,
	metadata_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_package_runtime_runs_user_started
ON package_runtime_runs(user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_package_runtime_runs_package_started
ON package_runtime_runs(user_id, package_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_package_runtime_runs_surface_started
ON package_runtime_runs(user_id, surface, started_at DESC);

CREATE TABLE IF NOT EXISTS package_runtime_logs (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	timestamp TEXT NOT NULL,
	sequence INTEGER NOT NULL,
	level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'log', 'warn', 'error')),
	message TEXT NOT NULL,
	fields_json TEXT,
	created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_package_runtime_logs_run_sequence
ON package_runtime_logs(run_id, sequence);

CREATE INDEX IF NOT EXISTS idx_package_runtime_logs_run
ON package_runtime_logs(run_id, timestamp, sequence);

CREATE INDEX IF NOT EXISTS idx_package_runtime_logs_user_package_created
ON package_runtime_logs(user_id, package_id, created_at DESC);
