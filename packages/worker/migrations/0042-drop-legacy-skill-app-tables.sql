DELETE FROM repo_sessions
WHERE source_id IN (
	SELECT id
	FROM entity_sources
	WHERE entity_kind IN ('skill', 'app')
);

DELETE FROM entity_sources
WHERE entity_kind IN ('skill', 'app');

DROP TABLE IF EXISTS mcp_skills;
DROP TABLE IF EXISTS ui_artifacts;
