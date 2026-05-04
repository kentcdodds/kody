ALTER TABLE entity_sources
	ADD COLUMN last_external_check_at TEXT;

CREATE INDEX IF NOT EXISTS idx_entity_sources_external_check
	ON entity_sources(last_external_check_at);
