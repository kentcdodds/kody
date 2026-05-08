CREATE TABLE IF NOT EXISTS workflow_runs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	source_type TEXT NOT NULL CHECK (source_type IN ('package', 'inline')),
	package_id TEXT,
	kody_id TEXT,
	source_id TEXT,
	workflow_name TEXT NOT NULL,
	export_name TEXT,
	idempotency_key TEXT NOT NULL,
	run_at TEXT NOT NULL,
	plan_date TEXT,
	status TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	completed_at TEXT,
	last_error TEXT
);

CREATE INDEX IF NOT EXISTS workflow_runs_user_created_idx
ON workflow_runs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workflow_runs_user_active_idx
ON workflow_runs(user_id, status);
