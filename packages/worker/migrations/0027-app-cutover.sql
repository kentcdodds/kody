PRAGMA defer_foreign_keys = ON;

CREATE TABLE apps (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	source_id TEXT NOT NULL,
	published_commit TEXT,
	repo_check_policy_json TEXT,
	hidden INTEGER NOT NULL DEFAULT 1 CHECK (hidden IN (0, 1)),
	keywords_json TEXT NOT NULL DEFAULT '[]',
	search_text TEXT,
	parameters_json TEXT,
	has_client INTEGER NOT NULL DEFAULT 0 CHECK (has_client IN (0, 1)),
	has_server INTEGER NOT NULL DEFAULT 0 CHECK (has_server IN (0, 1)),
	tasks_json TEXT NOT NULL DEFAULT '[]',
	jobs_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT INTO apps (
	id,
	user_id,
	title,
	description,
	source_id,
	published_commit,
	repo_check_policy_json,
	hidden,
	keywords_json,
	search_text,
	parameters_json,
	has_client,
	has_server,
	tasks_json,
	jobs_json,
	created_at,
	updated_at
)
SELECT
	ui.id,
	ui.user_id,
	ui.title,
	ui.description,
	ui.source_id,
	es.published_commit,
	NULL,
	ui.hidden,
	'[]',
	NULL,
	ui.parameters,
	1,
	ui.has_server_code,
	'[]',
	'[]',
	ui.created_at,
	ui.updated_at
FROM ui_artifacts ui
LEFT JOIN entity_sources es
	ON es.id = ui.source_id;

INSERT INTO apps (
	id,
	user_id,
	title,
	description,
	source_id,
	published_commit,
	repo_check_policy_json,
	hidden,
	keywords_json,
	search_text,
	parameters_json,
	has_client,
	has_server,
	tasks_json,
	jobs_json,
	created_at,
	updated_at
)
SELECT
	s.id,
	s.user_id,
	s.title,
	s.description,
	s.source_id,
	es.published_commit,
	NULL,
	1,
	s.keywords,
	s.search_text,
	s.parameters,
	0,
	0,
	json_array(
		json_object(
			'name', s.name,
			'title', s.title,
			'description', s.description,
			'entrypoint', 'src/tasks/default.ts',
			'keywords', json(s.keywords),
			'searchText', s.search_text,
			'parameters', CASE
				WHEN s.parameters IS NULL THEN NULL
				ELSE json(s.parameters)
			END,
			'readOnly', CASE WHEN s.read_only = 1 THEN json('true') ELSE json('false') END,
			'idempotent', CASE WHEN s.idempotent = 1 THEN json('true') ELSE json('false') END,
			'destructive', CASE WHEN s.destructive = 1 THEN json('true') ELSE json('false') END,
			'usesCapabilities', CASE
				WHEN s.uses_capabilities IS NULL THEN NULL
				ELSE json(s.uses_capabilities)
			END
		)
	),
	'[]',
	s.created_at,
	s.updated_at
FROM mcp_skills s
LEFT JOIN entity_sources es
	ON es.id = s.source_id;

INSERT INTO apps (
	id,
	user_id,
	title,
	description,
	source_id,
	published_commit,
	repo_check_policy_json,
	hidden,
	keywords_json,
	search_text,
	parameters_json,
	has_client,
	has_server,
	tasks_json,
	jobs_json,
	created_at,
	updated_at
)
SELECT
	j.id,
	j.user_id,
	j.name,
	j.name,
	j.source_id,
	j.published_commit,
	j.repo_check_policy_json,
	1,
	json('["job","scheduled"]'),
	j.name,
	NULL,
	0,
	0,
	json_array(
		json_object(
			'name', 'default',
			'title', j.name,
			'description', j.name,
			'entrypoint', 'src/tasks/default.ts'
		)
	),
	json_array(
		json_object(
			'id', j.id,
			'name', j.name,
			'title', j.name,
			'description', j.name,
			'task', 'default',
			'params', CASE
				WHEN j.params_json IS NULL THEN NULL
				ELSE json(j.params_json)
			END,
			'callerContext', json(j.caller_context_json),
			'schedule', json(j.schedule_json),
			'timezone', j.timezone,
			'enabled', CASE WHEN j.enabled = 1 THEN json('true') ELSE json('false') END,
			'killSwitchEnabled', CASE WHEN j.kill_switch_enabled = 1 THEN json('true') ELSE json('false') END,
			'storageId', j.storage_id,
			'lastRunAt', j.last_run_at,
			'lastRunStatus', j.last_run_status,
			'lastRunError', j.last_run_error,
			'lastDurationMs', j.last_duration_ms,
			'nextRunAt', j.next_run_at,
			'runCount', j.run_count,
			'successCount', j.success_count,
			'errorCount', j.error_count,
			'runHistory', json(j.run_history_json),
			'createdAt', j.created_at,
			'updatedAt', j.updated_at
		)
	),
	j.created_at,
	j.updated_at
FROM jobs j;

DROP INDEX IF EXISTS idx_entity_sources_user_entity;
DELETE FROM entity_sources
WHERE entity_kind != 'app';
UPDATE entity_sources
SET entity_kind = 'app',
	updated_at = CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX idx_entity_sources_user_entity
ON entity_sources(user_id, entity_kind, entity_id);

DROP TABLE mcp_skills;
DROP TABLE ui_artifacts;
DROP TABLE jobs;

DROP INDEX IF EXISTS idx_legacy_inline_sources_archive_user_id_entity_kind;
DROP TABLE IF EXISTS legacy_inline_sources_archive;

CREATE INDEX idx_apps_user_id ON apps(user_id);
CREATE INDEX idx_apps_source_id ON apps(source_id);
CREATE INDEX idx_apps_user_hidden_updated_at ON apps(user_id, hidden, updated_at);

PRAGMA defer_foreign_keys = OFF;
