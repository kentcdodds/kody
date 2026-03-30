ALTER TABLE mcp_skills ADD COLUMN collection_name TEXT;
ALTER TABLE mcp_skills ADD COLUMN collection_slug TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_skills_user_collection_slug
ON mcp_skills(user_id, collection_slug);
