-- Enforce users.plan and invites.plan as NOT NULL DEFAULT 'unlimited'.
-- SQLite cannot ALTER a column nullability in place, so rebuild both tables.
--
-- Deploy ordering: `.github/workflows/deploy.yml` applies D1 migrations before
-- the Worker. Reconcile any residual NULL to 'unlimited', fail closed if any
-- NULL remains, then rebuild.
--
-- Cloudflare D1 wraps each migration in a transaction, so PRAGMA foreign_keys=OFF
-- is a no-op there. With foreign keys still enforced, DROP TABLE users destroys or
-- nulls inbound FK rows (CASCADE / SET NULL). Snapshot every table that references
-- users, clear those rows, rebuild users, rebuild invites from its snapshot, then
-- restore the remaining snapshots.
--
-- No CHECK on plan values: unknown historical strings must remain data-preserved
-- (runtime continues to fail open via parseStoredPlanName). users.stripe_plan stays
-- nullable and is intentionally untouched by reconciliation.
--
-- Fail-closed layers: residual-NULL assertions after reconciliation, then
-- INSERT...SELECT plan (no COALESCE) into NOT NULL columns during rebuild.
--
-- AUTOINCREMENT: DROP TABLE users clears sqlite_sequence. Snapshot the users
-- high-water mark before DROP and restore/advance it after rename so previously
-- allocated (including deleted) ids are never reused.

UPDATE users SET plan = 'unlimited' WHERE plan IS NULL;
UPDATE invites SET plan = 'unlimited' WHERE plan IS NULL;

-- __migration_assertions intentionally uses CHECK (0) as an unreachable trap.
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'users.plan still contains NULL after unlimited reconciliation; aborting 0081.'
WHERE EXISTS (SELECT 1 FROM users WHERE plan IS NULL);

INSERT INTO __migration_assertions (message)
SELECT 'invites.plan still contains NULL after unlimited reconciliation; aborting 0081.'
WHERE EXISTS (SELECT 1 FROM invites WHERE plan IS NULL);

DROP TABLE __migration_assertions;

CREATE TABLE _mig0081_password_resets AS SELECT * FROM password_resets;
CREATE TABLE _mig0081_email_verifications AS SELECT * FROM email_verifications;
CREATE TABLE _mig0081_pending_email_changes AS SELECT * FROM pending_email_changes;
CREATE TABLE _mig0081_passkeys AS SELECT * FROM passkeys;
CREATE TABLE _mig0081_oauth_connections AS SELECT * FROM oauth_connections;
CREATE TABLE _mig0081_user_roles AS SELECT * FROM user_roles;
CREATE TABLE _mig0081_invites AS SELECT * FROM invites;
CREATE TABLE _mig0081_feature_flags AS SELECT * FROM feature_flags;
CREATE TABLE _mig0081_feature_flag_user_overrides AS
SELECT * FROM feature_flag_user_overrides;
CREATE TABLE _mig0081_users_seq AS
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
	plan TEXT NOT NULL DEFAULT 'unlimited',
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

-- Never lower the sequence: take the max of the post-rebuild value (live ids)
-- and the pre-DROP high-water mark (includes deleted allocations).
UPDATE sqlite_sequence
SET seq = (
	SELECT MAX(value) FROM (
		SELECT seq AS value FROM sqlite_sequence WHERE name = 'users'
		UNION ALL
		SELECT seq AS value FROM _mig0081_users_seq
	)
)
WHERE name = 'users'
	AND EXISTS (SELECT 1 FROM _mig0081_users_seq);

-- Empty live users leaves no sqlite_sequence row after rebuild; restore it.
INSERT INTO sqlite_sequence (name, seq)
SELECT 'users', seq FROM _mig0081_users_seq
WHERE EXISTS (SELECT 1 FROM _mig0081_users_seq)
	AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users');

DROP TABLE _mig0081_users_seq;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
	ON users(stable_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_id
	ON users(stripe_customer_id)
	WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE invites_next (
	code TEXT PRIMARY KEY NOT NULL,
	created_by INTEGER,
	note TEXT NOT NULL DEFAULT '',
	max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
	use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
	expires_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	plan TEXT NOT NULL DEFAULT 'unlimited',
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
	plan
FROM _mig0081_invites;

DROP TABLE invites;

ALTER TABLE invites_next RENAME TO invites;

CREATE INDEX IF NOT EXISTS idx_invites_created_at ON invites(created_at);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by);
CREATE INDEX IF NOT EXISTS idx_invites_expires_at ON invites(expires_at);

INSERT INTO password_resets SELECT * FROM _mig0081_password_resets;
INSERT INTO email_verifications SELECT * FROM _mig0081_email_verifications;
INSERT INTO pending_email_changes SELECT * FROM _mig0081_pending_email_changes;
INSERT INTO passkeys SELECT * FROM _mig0081_passkeys;
INSERT INTO oauth_connections SELECT * FROM _mig0081_oauth_connections;
INSERT INTO user_roles SELECT * FROM _mig0081_user_roles;
INSERT INTO feature_flags SELECT * FROM _mig0081_feature_flags;
INSERT INTO feature_flag_user_overrides
SELECT * FROM _mig0081_feature_flag_user_overrides;

DROP TABLE _mig0081_password_resets;
DROP TABLE _mig0081_email_verifications;
DROP TABLE _mig0081_pending_email_changes;
DROP TABLE _mig0081_passkeys;
DROP TABLE _mig0081_oauth_connections;
DROP TABLE _mig0081_user_roles;
DROP TABLE _mig0081_invites;
DROP TABLE _mig0081_feature_flags;
DROP TABLE _mig0081_feature_flag_user_overrides;
