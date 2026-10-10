-- One successful org.migrated row per org. A failure row does not count.
-- Stops when a duplicate success row already exists. Does not delete rows.
-- See tools/teams-migration/backfill-org-migrated-audit.ts.

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'duplicate org.migrated success rows; resolve them before 0003.'
WHERE EXISTS (
	SELECT 1
	FROM org_audit_events
	WHERE action = 'org.migrated' AND result = 'success'
	GROUP BY org_id
	HAVING COUNT(*) > 1
);

DROP TABLE __migration_assertions;

CREATE UNIQUE INDEX idx_org_audit_migrated_success
	ON org_audit_events (org_id)
	WHERE action = 'org.migrated' AND result = 'success';
