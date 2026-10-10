-- Teams P9 contract: delete leftover platform `users` rows through the
-- db_user_id account-data target list (#3084). The org, Owner membership, and
-- `handles` row stay. Fail closed when a platform user has no live handle, or
-- when any platform row remains after the deletes.

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

-- Keep handles (and orgs / memberships / packages). Drop only the users row.
DELETE FROM users
WHERE account_type = 'platform';

INSERT INTO __migration_assertions (message)
SELECT 'platform users rows remain after 0099 deletes; aborting.'
WHERE EXISTS (SELECT 1 FROM users WHERE account_type = 'platform');

DROP TABLE __migration_assertions;
