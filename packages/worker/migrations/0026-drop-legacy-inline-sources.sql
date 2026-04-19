PRAGMA defer_foreign_keys = ON;

CREATE TABLE mcp_skills_next (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	keywords TEXT NOT NULL,
	search_text TEXT,
	uses_capabilities TEXT,
	inferred_capabilities TEXT NOT NULL,
	inference_partial INTEGER NOT NULL DEFAULT 0,
	read_only INTEGER NOT NULL,
	idempotent INTEGER NOT NULL,
	destructive INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	parameters TEXT,
	collection_name TEXT,
	collection_slug TEXT,
	name TEXT NOT NULL,
	source_id TEXT NOT NULL
);

INSERT INTO mcp_skills_next (
	id,
	user_id,
	title,
	description,
	keywords,
	search_text,
	uses_capabilities,
	inferred_capabilities,
	inference_partial,
	read_only,
	idempotent,
	destructive,
	created_at,
	updated_at,
	parameters,
	collection_name,
	collection_slug,
	name,
	source_id
)
SELECT
	id,
	user_id,
	title,
	description,
	keywords,
	search_text,
	uses_capabilities,
	inferred_capabilities,
	inference_partial,
	read_only,
	idempotent,
	destructive,
	created_at,
	updated_at,
	parameters,
	collection_name,
	collection_slug,
	name,
	source_id
FROM mcp_skills;

DROP TABLE mcp_skills;
ALTER TABLE mcp_skills_next RENAME TO mcp_skills;

CREATE INDEX idx_mcp_skills_user_id ON mcp_skills(user_id);
CREATE INDEX idx_mcp_skills_source_id ON mcp_skills(source_id);
CREATE INDEX idx_mcp_skills_user_collection_slug
ON mcp_skills(user_id, collection_slug);
CREATE UNIQUE INDEX idx_mcp_skills_user_name
ON mcp_skills(user_id, name);

CREATE TABLE ui_artifacts_next (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	source_id TEXT NOT NULL,
	has_server_code INTEGER NOT NULL DEFAULT 0,
	parameters TEXT,
	hidden INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT INTO ui_artifacts_next (
	id,
	user_id,
	title,
	description,
	source_id,
	has_server_code,
	parameters,
	hidden,
	created_at,
	updated_at
)
SELECT
	id,
	user_id,
	title,
	description,
	source_id,
	CASE
		WHEN server_code IS NOT NULL AND TRIM(server_code) != '' THEN 1
		ELSE 0
	END AS has_server_code,
	parameters,
	hidden,
	created_at,
	updated_at
FROM ui_artifacts;

DROP TABLE ui_artifacts;
ALTER TABLE ui_artifacts_next RENAME TO ui_artifacts;

CREATE INDEX idx_ui_artifacts_user_id ON ui_artifacts(user_id);
CREATE INDEX idx_ui_artifacts_source_id ON ui_artifacts(source_id);

CREATE TABLE jobs_next (
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
	last_run_error TEXT,
	last_duration_ms INTEGER,
	next_run_at TEXT NOT NULL,
	run_count INTEGER NOT NULL DEFAULT 0,
	success_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	run_history_json TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO jobs_next (
	id,
	user_id,
	name,
	source_id,
	published_commit,
	repo_check_policy_json,
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
	repo_check_policy_json,
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
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;

CREATE INDEX idx_jobs_user_next_run_at
	ON jobs(user_id, enabled, kill_switch_enabled, next_run_at);
CREATE INDEX idx_jobs_user_name
	ON jobs(user_id, name);
CREATE INDEX idx_jobs_source_id
	ON jobs(source_id);

PRAGMA defer_foreign_keys = OFF;
