-- Rename the paid tiers without double-applying either stored value:
-- old partner -> new pro, old pro -> new standard. The single CASE updates
-- users.plan, users.stripe_plan, and invites.plan from their pre-migration
-- meanings exactly once.
--
-- SQLite cannot replace a CHECK constraint in place, so rebuild users and
-- invites. D1 wraps this file in a transaction with foreign keys enabled;
-- snapshot and clear every table that references users before dropping it,
-- then restore those rows after both parent tables are rebuilt.
--
-- Fail closed before destructive work when any stored plan is outside the
-- known pre/post-rename vocabulary. AUTOINCREMENT preserves the users
-- high-water mark so deleted ids are never reused.

PRAGMA defer_foreign_keys = TRUE;

DROP TABLE IF EXISTS __migration_assertions;

-- CHECK (0) is an intentionally unreachable assertion trap.
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'users.plan contains an unregistered value; aborting 0002.'
WHERE EXISTS (
	SELECT 1
	FROM users
	WHERE plan NOT IN ('free', 'partner', 'pro', 'standard', 'max')
);

INSERT INTO __migration_assertions (message)
SELECT 'users.stripe_plan contains an unregistered value; aborting 0002.'
WHERE EXISTS (
	SELECT 1
	FROM users
	WHERE stripe_plan IS NOT NULL
		AND stripe_plan NOT IN ('free', 'partner', 'pro', 'standard')
);

INSERT INTO __migration_assertions (message)
SELECT 'invites.plan contains an unregistered value; aborting 0002.'
WHERE EXISTS (
	SELECT 1
	FROM invites
	WHERE plan NOT IN ('free', 'partner', 'pro', 'standard', 'max')
);

DROP TABLE __migration_assertions;

CREATE TABLE _mig0002_password_resets AS SELECT * FROM password_resets;
CREATE TABLE _mig0002_email_verifications AS SELECT * FROM email_verifications;
CREATE TABLE _mig0002_pending_email_changes AS SELECT * FROM pending_email_changes;
CREATE TABLE _mig0002_passkeys AS SELECT * FROM passkeys;
CREATE TABLE _mig0002_oauth_connections AS SELECT * FROM oauth_connections;
CREATE TABLE _mig0002_user_roles AS SELECT * FROM user_roles;
CREATE TABLE _mig0002_invites AS SELECT * FROM invites;
CREATE TABLE _mig0002_feature_flags AS SELECT * FROM feature_flags;
CREATE TABLE _mig0002_feature_flag_user_overrides AS
SELECT * FROM feature_flag_user_overrides;
CREATE TABLE _mig0002_users_seq AS
SELECT seq FROM sqlite_sequence WHERE name = 'users';

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
	plan TEXT NOT NULL DEFAULT 'free' CHECK (
		plan IN ('free', 'standard', 'pro', 'max')
	),
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
	),
	deleting_at TEXT,
	active_write_count INTEGER NOT NULL DEFAULT 0,
	active_write_expires_at TEXT,
	suspended_at TEXT,
	email_outbound_paused_at TEXT,
	password_changed_at TEXT,
	job_retention_success_once_days INTEGER CHECK (
		job_retention_success_once_days IS NULL
		OR (
			job_retention_success_once_days >= 1
			AND job_retention_success_once_days <= 365
		)
	),
	job_retention_failed_once_days INTEGER CHECK (
		job_retention_failed_once_days IS NULL
		OR (
			job_retention_failed_once_days >= 1
			AND job_retention_failed_once_days <= 365
		)
	),
	job_retention_disabled_recurring_days INTEGER CHECK (
		job_retention_disabled_recurring_days IS NULL
		OR (
			job_retention_disabled_recurring_days >= 1
			AND job_retention_disabled_recurring_days <= 365
		)
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
	account_type,
	deleting_at,
	active_write_count,
	active_write_expires_at,
	suspended_at,
	email_outbound_paused_at,
	password_changed_at,
	job_retention_success_once_days,
	job_retention_failed_once_days,
	job_retention_disabled_recurring_days
)
SELECT
	id,
	username,
	email,
	password_hash,
	created_at,
	updated_at,
	email_verified_at,
	CASE plan
		WHEN 'partner' THEN 'pro'
		WHEN 'pro' THEN 'standard'
		ELSE plan
	END,
	stable_user_id,
	stripe_customer_id,
	CASE stripe_plan
		WHEN 'partner' THEN 'pro'
		WHEN 'pro' THEN 'standard'
		ELSE stripe_plan
	END,
	stripe_plan_refreshed_at,
	display_name,
	bio,
	profile_visibility,
	avatar_key,
	account_type,
	deleting_at,
	active_write_count,
	active_write_expires_at,
	suspended_at,
	email_outbound_paused_at,
	password_changed_at,
	job_retention_success_once_days,
	job_retention_failed_once_days,
	job_retention_disabled_recurring_days
FROM users;

DROP TABLE users;

ALTER TABLE users_next RENAME TO users;

UPDATE sqlite_sequence
SET seq = (
	SELECT MAX(value) FROM (
		SELECT seq AS value FROM sqlite_sequence WHERE name = 'users'
		UNION ALL
		SELECT seq AS value FROM _mig0002_users_seq
	)
)
WHERE name = 'users'
	AND EXISTS (SELECT 1 FROM _mig0002_users_seq);

INSERT INTO sqlite_sequence (name, seq)
SELECT 'users', seq FROM _mig0002_users_seq
WHERE EXISTS (SELECT 1 FROM _mig0002_users_seq)
	AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users');

DROP TABLE _mig0002_users_seq;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
	ON users(stable_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_id
	ON users(stripe_customer_id)
	WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_deleting_at
	ON users(deleting_at)
	WHERE deleting_at IS NOT NULL;

CREATE TABLE invites_next (
	code TEXT PRIMARY KEY NOT NULL,
	created_by INTEGER,
	note TEXT NOT NULL DEFAULT '',
	max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
	use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
	expires_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	plan TEXT NOT NULL DEFAULT 'free' CHECK (
		plan IN ('free', 'standard', 'pro', 'max')
	),
	FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO invites_next (
	code,
	created_by,
	note,
	max_uses,
	use_count,
	expires_at,
	revoked_at,
	created_at,
	plan
)
SELECT
	code,
	created_by,
	note,
	max_uses,
	use_count,
	expires_at,
	revoked_at,
	created_at,
	CASE plan
		WHEN 'partner' THEN 'pro'
		WHEN 'pro' THEN 'standard'
		ELSE plan
	END
FROM _mig0002_invites;

DROP TABLE invites;

ALTER TABLE invites_next RENAME TO invites;

CREATE INDEX IF NOT EXISTS idx_invites_created_at ON invites(created_at);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by);
CREATE INDEX IF NOT EXISTS idx_invites_expires_at ON invites(expires_at);

INSERT INTO password_resets SELECT * FROM _mig0002_password_resets;
INSERT INTO email_verifications SELECT * FROM _mig0002_email_verifications;
INSERT INTO pending_email_changes SELECT * FROM _mig0002_pending_email_changes;
INSERT INTO passkeys SELECT * FROM _mig0002_passkeys;
INSERT INTO oauth_connections SELECT * FROM _mig0002_oauth_connections;
INSERT INTO user_roles SELECT * FROM _mig0002_user_roles;
INSERT INTO feature_flags SELECT * FROM _mig0002_feature_flags;
INSERT INTO feature_flag_user_overrides
SELECT * FROM _mig0002_feature_flag_user_overrides;

DROP TABLE _mig0002_password_resets;
DROP TABLE _mig0002_email_verifications;
DROP TABLE _mig0002_pending_email_changes;
DROP TABLE _mig0002_passkeys;
DROP TABLE _mig0002_oauth_connections;
DROP TABLE _mig0002_user_roles;
DROP TABLE _mig0002_invites;
DROP TABLE _mig0002_feature_flags;
DROP TABLE _mig0002_feature_flag_user_overrides;

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'legacy plan values remain after tier restructure; aborting 0002.'
WHERE EXISTS (SELECT 1 FROM users WHERE plan IN ('partner'))
	OR EXISTS (SELECT 1 FROM users WHERE stripe_plan IN ('partner'))
	OR EXISTS (SELECT 1 FROM invites WHERE plan IN ('partner'));

DROP TABLE __migration_assertions;
