-- One successful org.migrated row per org. A failure row does not count.
-- See tools/teams-migration/backfill-org-migrated-audit.ts.

CREATE UNIQUE INDEX idx_org_audit_migrated_success
	ON org_audit_events (org_id)
	WHERE action = 'org.migrated' AND result = 'success';
