PRAGMA defer_foreign_keys = ON;

CREATE TABLE ui_artifacts_v3 (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	source_id TEXT NOT NULL,
	parameters TEXT,
	hidden INTEGER NOT NULL DEFAULT 1,
	has_server_code INTEGER,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT INTO ui_artifacts_v3 (
	id,
	user_id,
	title,
	description,
	source_id,
	parameters,
	hidden,
	has_server_code,
	created_at,
	updated_at
)
SELECT
	id,
	user_id,
	title,
	description,
	source_id,
	parameters,
	hidden,
	NULL AS has_server_code,
	created_at,
	updated_at
FROM ui_artifacts
WHERE source_id IS NOT NULL;

DROP TABLE ui_artifacts;

ALTER TABLE ui_artifacts_v3 RENAME TO ui_artifacts;

CREATE INDEX IF NOT EXISTS idx_ui_artifacts_user_id
ON ui_artifacts(user_id);

CREATE INDEX IF NOT EXISTS idx_ui_artifacts_source_id
ON ui_artifacts(source_id);

CREATE TABLE mcp_skills_v2 (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	source_id TEXT NOT NULL,
	keywords TEXT NOT NULL,
	search_text TEXT,
	uses_capabilities TEXT,
	parameters TEXT,
	collection_name TEXT,
	collection_slug TEXT,
	inferred_capabilities TEXT NOT NULL,
	inference_partial INTEGER NOT NULL DEFAULT 0,
	read_only INTEGER NOT NULL,
	idempotent INTEGER NOT NULL,
	destructive INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT INTO mcp_skills_v2 (
	id,
	user_id,
	name,
	title,
	description,
	source_id,
	keywords,
	search_text,
	uses_capabilities,
	parameters,
	collection_name,
	collection_slug,
	inferred_capabilities,
	inference_partial,
	read_only,
	idempotent,
	destructive,
	created_at,
	updated_at
)
SELECT
	id,
	user_id,
	name,
	title,
	description,
	source_id,
	keywords,
	search_text,
	uses_capabilities,
	parameters,
	collection_name,
	collection_slug,
	inferred_capabilities,
	inference_partial,
	read_only,
	idempotent,
	destructive,
	created_at,
	updated_at
FROM mcp_skills
WHERE source_id IS NOT NULL;

DROP TABLE mcp_skills;

ALTER TABLE mcp_skills_v2 RENAME TO mcp_skills;

CREATE INDEX IF NOT EXISTS idx_mcp_skills_user_id
ON mcp_skills(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_skills_user_name
ON mcp_skills(user_id, name);

CREATE INDEX IF NOT EXISTS idx_mcp_skills_source_id
ON mcp_skills(source_id);

PRAGMA defer_foreign_keys = OFF;
