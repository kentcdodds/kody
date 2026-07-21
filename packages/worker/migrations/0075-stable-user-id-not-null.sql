-- Enforce users.stable_user_id as NOT NULL after production backfill is complete.
-- SQLite cannot ALTER a column nullability in place, so rebuild the table.
--
-- Cloudflare D1 wraps each migration in a transaction, so PRAGMA foreign_keys=OFF
-- is a no-op there. With foreign keys still enforced, DROP TABLE users destroys or
-- nulls inbound FK rows (CASCADE / SET NULL). Snapshot every table that references
-- users, clear those rows, rebuild users, then restore the snapshots.
-- Fail-closed: users_next.stable_user_id is NOT NULL with no default, so any
-- remaining NULL stable ids abort the migration (and D1 rolls the transaction back).

CREATE TABLE _mig0075_password_resets AS SELECT * FROM password_resets;
CREATE TABLE _mig0075_email_verifications AS SELECT * FROM email_verifications;
CREATE TABLE _mig0075_pending_email_changes AS SELECT * FROM pending_email_changes;
CREATE TABLE _mig0075_passkeys AS SELECT * FROM passkeys;
CREATE TABLE _mig0075_oauth_connections AS SELECT * FROM oauth_connections;
CREATE TABLE _mig0075_user_roles AS SELECT * FROM user_roles;
CREATE TABLE _mig0075_invites AS SELECT * FROM invites;
CREATE TABLE _mig0075_feature_flags AS SELECT * FROM feature_flags;
CREATE TABLE _mig0075_feature_flag_user_overrides AS
SELECT * FROM feature_flag_user_overrides;

DELETE FROM feature_flag_user_overrides;
DELETE FROM feature_flags;
DELETE FROM invites;
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
	plan TEXT DEFAULT NULL,
	stable_user_id TEXT NOT NULL,
	stripe_customer_id TEXT,
	stripe_plan TEXT,
	stripe_plan_refreshed_at TEXT,
	display_name TEXT,
	bio TEXT,
	profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (
		profile_visibility IN ('public', 'private')
	),
	avatar_key TEXT,
	account_type TEXT NOT NULL DEFAULT 'person' CHECK (
		account_type IN ('person', 'platform')
	)
);

INSERT INTO users_next (
	id,
	username,
	email,
	password_hash,
	created_at,
	updated_at,
	email_verified_at,
	plan,
	stable_user_id,
	stripe_customer_id,
	stripe_plan,
	stripe_plan_refreshed_at,
	display_name,
	bio,
	profile_visibility,
	avatar_key,
	account_type
)
SELECT
	id,
	username,
	email,
	password_hash,
	created_at,
	updated_at,
	email_verified_at,
	plan,
	stable_user_id,
	stripe_customer_id,
	stripe_plan,
	stripe_plan_refreshed_at,
	display_name,
	bio,
	profile_visibility,
	avatar_key,
	account_type
FROM users;

DROP TABLE users;

ALTER TABLE users_next RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
	ON users(stable_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_id
	ON users(stripe_customer_id)
	WHERE stripe_customer_id IS NOT NULL;

INSERT INTO password_resets SELECT * FROM _mig0075_password_resets;
INSERT INTO email_verifications SELECT * FROM _mig0075_email_verifications;
INSERT INTO pending_email_changes SELECT * FROM _mig0075_pending_email_changes;
INSERT INTO passkeys SELECT * FROM _mig0075_passkeys;
INSERT INTO oauth_connections SELECT * FROM _mig0075_oauth_connections;
INSERT INTO user_roles SELECT * FROM _mig0075_user_roles;
INSERT INTO invites SELECT * FROM _mig0075_invites;
INSERT INTO feature_flags SELECT * FROM _mig0075_feature_flags;
INSERT INTO feature_flag_user_overrides
SELECT * FROM _mig0075_feature_flag_user_overrides;

DROP TABLE _mig0075_password_resets;
DROP TABLE _mig0075_email_verifications;
DROP TABLE _mig0075_pending_email_changes;
DROP TABLE _mig0075_passkeys;
DROP TABLE _mig0075_oauth_connections;
DROP TABLE _mig0075_user_roles;
DROP TABLE _mig0075_invites;
DROP TABLE _mig0075_feature_flags;
DROP TABLE _mig0075_feature_flag_user_overrides;
