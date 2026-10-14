-- #3053 phase 3 (narrow): assert live users still have personal_org_id after
-- phase 1 backfill and phase 2 dual-write. Readers no longer COALESCE to
-- stable_user_id. Existing personal orgs keep orgs.id = stable_user_id;
-- this migration does not move org rows or drop the column.

UPDATE users
SET personal_org_id = stable_user_id
WHERE personal_org_id IS NULL OR TRIM(personal_org_id) = '';

DROP TABLE IF EXISTS __migration_assertions;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'users.personal_org_id is null/blank on a live row during 0147 narrow. Aborting.'
WHERE EXISTS (
	SELECT 1 FROM users
	WHERE deleted_at IS NULL
		AND (personal_org_id IS NULL OR TRIM(personal_org_id) = '')
);

DROP TABLE __migration_assertions;
