ALTER TABLE mcp_skills ADD COLUMN connection_bindings TEXT;
ALTER TABLE mcp_skills ADD COLUMN template_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_skills_user_template_key
	ON mcp_skills(user_id, template_key)
	WHERE template_key IS NOT NULL;
