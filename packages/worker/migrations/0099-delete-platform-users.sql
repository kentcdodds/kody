-- Teams P9 contract: delete leftover platform `users` rows through the
-- db_user_id account-data target list (#3084). The org and `handles` row stay.
-- Soft-delete the founding Owner membership (user_id = org_id = platform
-- stable id) so it cannot count as a live Owner after the users row is gone.
-- Fail closed when a platform org lacks a live human Owner, has no handle, or
-- when any platform users row remains after the deletes.

DROP TABLE IF EXISTS __migration_assertions;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

-- Every platform user must already hold a handle on the converted org.
INSERT INTO __migration_assertions (message)
SELECT
	'platform user @' || u.username || ' has no handles row; aborting 0099.'
FROM users u
WHERE u.account_type = 'platform'
	AND NOT EXISTS (
		SELECT 1
		FROM handles h
		WHERE h.org_id = u.stable_user_id
			OR h.handle = u.username
	);

-- Every platform org must keep at least one live human Owner (not the
-- founding self-membership) before we remove the phantom Owner row.
INSERT INTO __migration_assertions (message)
SELECT
	'platform org @' || u.username
		|| ' has no live human Owner; aborting 0099.'
FROM users u
WHERE u.account_type = 'platform'
	AND NOT EXISTS (
		SELECT 1
		FROM org_memberships m
		WHERE m.org_id = u.stable_user_id
			AND m.user_id != u.stable_user_id
			AND m.role = 'owner'
			AND m.deleted_at IS NULL
	);

-- Soft-delete founding self-memberships so they stop counting as Owners.
UPDATE org_memberships
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE deleted_at IS NULL
	AND org_id = user_id
	AND user_id IN (
		SELECT stable_user_id FROM users WHERE account_type = 'platform'
	);

UPDATE orgs
SET access_epoch = access_epoch + 1,
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
	SELECT stable_user_id FROM users WHERE account_type = 'platform'
);

-- db_user_id targets (integer users.id), then verifications keyed by target.
DELETE FROM transactional_email_delivery_index
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM email_verifications
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM pending_email_changes
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM pending_email_destination_verifications
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM email_notification_destinations
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM pending_email_claim_releases
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM user_email_claims
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM password_resets
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM user_roles
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM passkeys
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM user_mcp_oauth_clients
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM oauth_connections
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM feature_flag_user_overrides
WHERE user_id IN (SELECT id FROM users WHERE account_type = 'platform');

DELETE FROM verifications
WHERE target IN (
	SELECT CAST(id AS TEXT) FROM users WHERE account_type = 'platform'
);

-- Keep handles, orgs, packages, and human memberships. Drop only the users row.
DELETE FROM users
WHERE account_type = 'platform';

INSERT INTO __migration_assertions (message)
SELECT 'platform users rows remain after 0099 deletes; aborting.'
WHERE EXISTS (SELECT 1 FROM users WHERE account_type = 'platform');

DROP TABLE __migration_assertions;
