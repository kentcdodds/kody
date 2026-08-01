ALTER TABLE entity_sources
ADD COLUMN external_check_until TEXT;

CREATE INDEX IF NOT EXISTS idx_entity_sources_pending_external_reconcile
ON entity_sources(external_check_until, last_external_check_at, id)
WHERE entity_kind = 'package' AND external_check_until IS NOT NULL;
