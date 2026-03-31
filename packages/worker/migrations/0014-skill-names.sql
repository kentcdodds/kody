ALTER TABLE mcp_skills ADD COLUMN name TEXT;

UPDATE mcp_skills
SET name = lower(replace(trim(title), ' ', '-'))
WHERE name IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_skills_user_name
ON mcp_skills(user_id, name);
