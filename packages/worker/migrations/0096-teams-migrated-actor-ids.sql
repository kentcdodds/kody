-- Teams: 0091 converted package shares into grants and invites with the
-- sharing org's id as the actor (grants.created_by_user_id and
-- invites.invited_by_user_id). For a personal org that id is also the Owner's
-- person id, so nothing changes there. For an org that was a platform account
-- the id names no person; those rows are rewritten to the org's earliest live
-- Owner who is a person (users.account_type = 'person', not deleted; earliest
-- membership, then user id for a stable tie-break). The platform account's own
-- self-Owner membership from 0089 is never chosen.
--
-- Idempotent: only rows whose actor still equals the org id of a non-person
-- org are touched, and only when such a person Owner exists. Rows for orgs
-- with no person Owner are left unchanged (they show up as "skipped").
--
-- Dry-run counts. "eligible" is expected to be 0 after apply; "skipped" is
-- unchanged by this migration.
--   -- grants, eligible
--   SELECT COUNT(*) FROM grants g WHERE g.id LIKE 'p8-share-%'
--     AND g.created_by_user_id = g.org_id
--     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.stable_user_id = g.org_id AND u.account_type = 'person')
--     AND EXISTS (SELECT 1 FROM org_memberships m INNER JOIN users u ON u.stable_user_id = m.user_id AND u.account_type = 'person' AND u.deleted_at IS NULL
--                 WHERE m.org_id = g.org_id AND m.role = 'owner' AND m.deleted_at IS NULL);
--   -- grants, skipped (no person Owner)
--   SELECT COUNT(*) FROM grants g WHERE g.id LIKE 'p8-share-%'
--     AND g.created_by_user_id = g.org_id
--     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.stable_user_id = g.org_id AND u.account_type = 'person')
--     AND NOT EXISTS (SELECT 1 FROM org_memberships m INNER JOIN users u ON u.stable_user_id = m.user_id AND u.account_type = 'person' AND u.deleted_at IS NULL
--                     WHERE m.org_id = g.org_id AND m.role = 'owner' AND m.deleted_at IS NULL);
--   -- invites, eligible / skipped: same two queries over invites i with
--   -- i.invited_by_user_id = i.org_id in place of g.created_by_user_id = g.org_id.
--
-- Reverse (restore the org id as the actor on the migrated rows):
--   UPDATE grants SET created_by_user_id = org_id WHERE id LIKE 'p8-share-%' AND created_by_user_id <> org_id;
--   UPDATE invites SET invited_by_user_id = org_id WHERE id LIKE 'p8-share-%' AND invited_by_user_id <> org_id;

UPDATE grants
SET created_by_user_id = (
	SELECT m.user_id FROM org_memberships m
	INNER JOIN users u
		ON u.stable_user_id = m.user_id
		AND u.account_type = 'person'
		AND u.deleted_at IS NULL
	WHERE m.org_id = grants.org_id
		AND m.role = 'owner'
		AND m.deleted_at IS NULL
	ORDER BY m.created_at, m.user_id
	LIMIT 1
)
WHERE id LIKE 'p8-share-%'
	AND created_by_user_id = org_id
	AND NOT EXISTS (
		SELECT 1 FROM users u
		WHERE u.stable_user_id = grants.org_id AND u.account_type = 'person'
	)
	AND EXISTS (
		SELECT 1 FROM org_memberships m
		INNER JOIN users u
			ON u.stable_user_id = m.user_id
			AND u.account_type = 'person'
			AND u.deleted_at IS NULL
		WHERE m.org_id = grants.org_id
			AND m.role = 'owner'
			AND m.deleted_at IS NULL
	);

UPDATE invites
SET invited_by_user_id = (
	SELECT m.user_id FROM org_memberships m
	INNER JOIN users u
		ON u.stable_user_id = m.user_id
		AND u.account_type = 'person'
		AND u.deleted_at IS NULL
	WHERE m.org_id = invites.org_id
		AND m.role = 'owner'
		AND m.deleted_at IS NULL
	ORDER BY m.created_at, m.user_id
	LIMIT 1
)
WHERE id LIKE 'p8-share-%'
	AND invited_by_user_id = org_id
	AND NOT EXISTS (
		SELECT 1 FROM users u
		WHERE u.stable_user_id = invites.org_id AND u.account_type = 'person'
	)
	AND EXISTS (
		SELECT 1 FROM org_memberships m
		INNER JOIN users u
			ON u.stable_user_id = m.user_id
			AND u.account_type = 'person'
			AND u.deleted_at IS NULL
		WHERE m.org_id = invites.org_id
			AND m.role = 'owner'
			AND m.deleted_at IS NULL
	);
