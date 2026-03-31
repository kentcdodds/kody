ALTER TABLE mcp_skills ADD COLUMN name TEXT;

WITH base_names AS (
	SELECT
		id,
		user_id,
		lower(replace(trim(title), ' ', '-')) AS base_name
	FROM mcp_skills
	WHERE name IS NULL
),
ranked AS (
	SELECT
		id,
		user_id,
		base_name,
		COUNT(*) OVER (PARTITION BY user_id, base_name) AS name_count,
		ROW_NUMBER() OVER (PARTITION BY user_id, base_name ORDER BY id) AS name_index
	FROM base_names
)
UPDATE mcp_skills
SET name = (
	SELECT
		CASE
			WHEN ranked.name_count = 1 OR ranked.name_index = 1 THEN ranked.base_name
			ELSE ranked.base_name || '-' || ranked.name_index
		END
	FROM ranked
	WHERE ranked.id = mcp_skills.id
)
WHERE name IS NULL;

CREATE TABLE IF NOT EXISTS mcp_skills_next (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	keywords TEXT NOT NULL,
	code TEXT NOT NULL,
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
	name TEXT NOT NULL
);

INSERT INTO mcp_skills_next (
	id, user_id, title, description, keywords, code, search_text,
	uses_capabilities, inferred_capabilities, inference_partial, read_only,
	idempotent, destructive, created_at, updated_at, parameters,
	collection_name, collection_slug, name
)
SELECT
	id, user_id, title, description, keywords, code, search_text,
	uses_capabilities, inferred_capabilities, inference_partial, read_only,
	idempotent, destructive, created_at, updated_at, parameters,
	collection_name, collection_slug, name
FROM mcp_skills;

DROP TABLE mcp_skills;
ALTER TABLE mcp_skills_next RENAME TO mcp_skills;

CREATE INDEX IF NOT EXISTS idx_mcp_skills_user_id ON mcp_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_skills_user_collection_slug
ON mcp_skills(user_id, collection_slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_skills_user_name
ON mcp_skills(user_id, name);
