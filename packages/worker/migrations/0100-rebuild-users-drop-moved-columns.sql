-- Teams P9 contract: rebuild `users` without columns that moved to `orgs`
-- (billing, Stripe, gifts, retention, outbound pause) and without
-- `account_type` / unused `active_write_*` (#3050, #3084). SQLite cannot drop
-- CHECKed columns or partial unique indexes in place, so this follows the
-- 0002-style snapshot / restore with `PRAGMA defer_foreign_keys`.
--
-- Platform users must already be gone (0099). Fail closed if any remain, or if
-- a row still has a non-person `account_type`.

PRAGMA defer_foreign_keys = TRUE;

DROP TABLE IF EXISTS __migration_assertions;

CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'platform users remain before users rebuild; run 0099 first.'
WHERE EXISTS (SELECT 1 FROM users WHERE account_type = 'platform');

INSERT INTO __migration_assertions (message)
SELECT 'users.account_type has a value outside person; aborting 0100.'
WHERE EXISTS (
	SELECT 1 FROM users WHERE account_type IS NOT NULL AND account_type != 'person'
);

DROP TABLE __migration_assertions;

CREATE TABLE _mig0100_password_resets AS SELECT * FROM password_resets;
CREATE TABLE _mig0100_email_verifications AS SELECT * FROM email_verifications;
CREATE TABLE _mig0100_pending_email_changes AS SELECT * FROM pending_email_changes;
CREATE TABLE _mig0100_pending_email_claim_releases AS
SELECT * FROM pending_email_claim_releases;
CREATE TABLE _mig0100_passkeys AS SELECT * FROM passkeys;
CREATE TABLE _mig0100_oauth_connections AS SELECT * FROM oauth_connections;
CREATE TABLE _mig0100_user_roles AS SELECT * FROM user_roles;
CREATE TABLE _mig0100_user_email_claims AS SELECT * FROM user_email_claims;
CREATE TABLE _mig0100_email_notification_destinations AS
SELECT * FROM email_notification_destinations;
CREATE TABLE _mig0100_pending_email_destination_verifications AS
SELECT * FROM pending_email_destination_verifications;
CREATE TABLE _mig0100_transactional_email_delivery_index AS
SELECT * FROM transactional_email_delivery_index;
CREATE TABLE _mig0100_user_mcp_oauth_clients AS
SELECT * FROM user_mcp_oauth_clients;
CREATE TABLE _mig0100_feature_flag_user_overrides AS
SELECT * FROM feature_flag_user_overrides;
CREATE TABLE _mig0100_feature_flags AS SELECT * FROM feature_flags;
CREATE TABLE _mig0100_users_seq AS
SELECT seq FROM sqlite_sequence WHERE name = 'users';

DELETE FROM feature_flag_user_overrides;
DELETE FROM feature_flags;
DELETE FROM user_mcp_oauth_clients;
DELETE FROM transactional_email_delivery_index;
DELETE FROM pending_email_destination_verifications;
DELETE FROM email_notification_destinations;
DELETE FROM user_email_claims;
DELETE FROM pending_email_claim_releases;
DELETE FROM user_roles;
DELETE FROM oauth_connections;
DELETE FROM passkeys;
DELETE FROM pending_email_changes;
DELETE FROM email_verifications;
DELETE FROM password_resets;

CREATE TABLE users_next (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	username TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	email_verified_at TEXT,
	stable_user_id TEXT NOT NULL,
	display_name TEXT,
	bio TEXT,
	profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (
		profile_visibility IN ('public', 'private')
	),
	avatar_key TEXT,
	deleting_at TEXT,
	suspended_at TEXT,
	password_changed_at TEXT,
	onboarding_checklist_dismissed_at TEXT,
	email_verification_delivery_status TEXT,
	email_verification_delivery_at TEXT,
	email_verification_delivery_detail TEXT,
	email_verification_delivery_class TEXT,
	utm_source TEXT,
	utm_medium TEXT,
	utm_campaign TEXT,
	utm_content TEXT,
	utm_term TEXT,
	first_touch_landing_path TEXT,
	first_touch_referrer TEXT,
	first_mcp_connected_at TEXT,
	first_execute_at TEXT,
	first_saved_package_at TEXT,
	mcp_client_name TEXT,
	last_active_at TEXT,
	first_search_at TEXT,
	experiments_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (
		experiments_opt_in IN (0, 1)
	),
	first_secret_at TEXT,
	first_integration_at TEXT,
	first_job_at TEXT,
	deleted_at TEXT
);

INSERT INTO users_next (
	id,
	username,
	email,
	password_hash,
	created_at,
	updated_at,
	email_verified_at,
	stable_user_id,
	display_name,
	bio,
	profile_visibility,
	avatar_key,
	deleting_at,
	suspended_at,
	password_changed_at,
	onboarding_checklist_dismissed_at,
	email_verification_delivery_status,
	email_verification_delivery_at,
	email_verification_delivery_detail,
	email_verification_delivery_class,
	utm_source,
	utm_medium,
	utm_campaign,
	utm_content,
	utm_term,
	first_touch_landing_path,
	first_touch_referrer,
	first_mcp_connected_at,
	first_execute_at,
	first_saved_package_at,
	mcp_client_name,
	last_active_at,
	first_search_at,
	experiments_opt_in,
	first_secret_at,
	first_integration_at,
	first_job_at,
	deleted_at
)
SELECT
	id,
	username,
	email,
	password_hash,
	created_at,
	updated_at,
	email_verified_at,
	stable_user_id,
	display_name,
	bio,
	profile_visibility,
	avatar_key,
	deleting_at,
	suspended_at,
	password_changed_at,
	onboarding_checklist_dismissed_at,
	email_verification_delivery_status,
	email_verification_delivery_at,
	email_verification_delivery_detail,
	email_verification_delivery_class,
	utm_source,
	utm_medium,
	utm_campaign,
	utm_content,
	utm_term,
	first_touch_landing_path,
	first_touch_referrer,
	first_mcp_connected_at,
	first_execute_at,
	first_saved_package_at,
	mcp_client_name,
	last_active_at,
	first_search_at,
	experiments_opt_in,
	first_secret_at,
	first_integration_at,
	first_job_at,
	deleted_at
FROM users;

DROP TABLE users;

ALTER TABLE users_next RENAME TO users;

UPDATE sqlite_sequence
SET seq = (
	SELECT MAX(value) FROM (
		SELECT seq AS value FROM sqlite_sequence WHERE name = 'users'
		UNION ALL
		SELECT seq AS value FROM _mig0100_users_seq
	)
)
WHERE name = 'users'
	AND EXISTS (SELECT 1 FROM _mig0100_users_seq);

INSERT INTO sqlite_sequence (name, seq)
SELECT 'users', seq FROM _mig0100_users_seq
WHERE EXISTS (SELECT 1 FROM _mig0100_users_seq)
	AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users');

DROP TABLE _mig0100_users_seq;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
	ON users(stable_user_id);
CREATE INDEX IF NOT EXISTS idx_users_deleting_at
	ON users(deleting_at)
	WHERE deleting_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_created_at
	ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_users_last_active_at
	ON users(last_active_at)
	WHERE last_active_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_mcp_client_name
	ON users(mcp_client_name)
	WHERE first_mcp_connected_at IS NOT NULL;

INSERT INTO feature_flags SELECT * FROM _mig0100_feature_flags;
INSERT INTO feature_flag_user_overrides
SELECT * FROM _mig0100_feature_flag_user_overrides;
INSERT INTO user_mcp_oauth_clients
SELECT * FROM _mig0100_user_mcp_oauth_clients;
INSERT INTO transactional_email_delivery_index
SELECT * FROM _mig0100_transactional_email_delivery_index;
INSERT INTO email_notification_destinations
SELECT * FROM _mig0100_email_notification_destinations;
INSERT INTO pending_email_destination_verifications
SELECT * FROM _mig0100_pending_email_destination_verifications;
INSERT INTO user_email_claims SELECT * FROM _mig0100_user_email_claims;
INSERT INTO pending_email_claim_releases
SELECT * FROM _mig0100_pending_email_claim_releases;
INSERT INTO user_roles SELECT * FROM _mig0100_user_roles;
INSERT INTO oauth_connections SELECT * FROM _mig0100_oauth_connections;
INSERT INTO passkeys SELECT * FROM _mig0100_passkeys;
INSERT INTO pending_email_changes SELECT * FROM _mig0100_pending_email_changes;
INSERT INTO email_verifications SELECT * FROM _mig0100_email_verifications;
INSERT INTO password_resets SELECT * FROM _mig0100_password_resets;

DROP TABLE _mig0100_feature_flag_user_overrides;
DROP TABLE _mig0100_feature_flags;
DROP TABLE _mig0100_user_mcp_oauth_clients;
DROP TABLE _mig0100_transactional_email_delivery_index;
DROP TABLE _mig0100_pending_email_destination_verifications;
DROP TABLE _mig0100_email_notification_destinations;
DROP TABLE _mig0100_user_email_claims;
DROP TABLE _mig0100_pending_email_claim_releases;
DROP TABLE _mig0100_user_roles;
DROP TABLE _mig0100_oauth_connections;
DROP TABLE _mig0100_passkeys;
DROP TABLE _mig0100_pending_email_changes;
DROP TABLE _mig0100_email_verifications;
DROP TABLE _mig0100_password_resets;
