-- #3053 phase 1 (widen): record each person's personal org id on the user
-- row. Existing and new personal orgs keep orgs.id = users.stable_user_id.
-- Later phases switch readers, then mint distinct org ids for new signups.
-- This migration does not move org rows.

ALTER TABLE users ADD COLUMN personal_org_id TEXT;

UPDATE users
SET personal_org_id = stable_user_id
WHERE personal_org_id IS NULL OR TRIM(personal_org_id) = '';

DROP TABLE IF EXISTS __migration_assertions;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'users.personal_org_id is null after 0142 backfill. Aborting.'
WHERE EXISTS (
	SELECT 1 FROM users
	WHERE deleted_at IS NULL
		AND (personal_org_id IS NULL OR TRIM(personal_org_id) = '')
);

INSERT INTO __migration_assertions (message)
SELECT 'users.personal_org_id differs from stable_user_id during 0142 widen. Aborting.'
WHERE EXISTS (
	SELECT 1 FROM users
	WHERE personal_org_id IS NOT NULL
		AND TRIM(personal_org_id) != ''
		AND personal_org_id != stable_user_id
);

DROP TABLE __migration_assertions;

-- Live rows only (deleted_at IS NULL, same predicate as liveDeletedAtSql).
-- A soft-deleted account may keep the mapping without blocking a live row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_personal_org_id
	ON users(personal_org_id)
	WHERE deleted_at IS NULL;
