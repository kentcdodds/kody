-- Teams P3 expand backfill: one org per user (id = stable_user_id), owner
-- membership, handles namespace, copied billing/profile columns, and actor
-- columns. Old users columns stay. Fail closed if a user already has an org
-- with a different id shape expectation.

-- Assert no pre-existing orgs (this migration owns the first seed).
DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'orgs already has rows before Teams expand backfill; aborting 0089.'
WHERE EXISTS (SELECT 1 FROM orgs LIMIT 1);

INSERT INTO __migration_assertions (message)
SELECT 'org_memberships already has rows before Teams expand backfill; aborting 0089.'
WHERE EXISTS (SELECT 1 FROM org_memberships LIMIT 1);

INSERT INTO __migration_assertions (message)
SELECT 'handles already has rows before Teams expand backfill; aborting 0089.'
WHERE EXISTS (SELECT 1 FROM handles LIMIT 1);

INSERT INTO __migration_assertions (message)
SELECT 'users.stable_user_id is missing; aborting 0089.'
WHERE EXISTS (
	SELECT 1 FROM users
	WHERE stable_user_id IS NULL OR TRIM(stable_user_id) = ''
);

INSERT INTO __migration_assertions (message)
SELECT 'users.username is missing; aborting 0089.'
WHERE EXISTS (
	SELECT 1 FROM users
	WHERE username IS NULL OR TRIM(username) = ''
);

DROP TABLE __migration_assertions;

-- One org per user. Migrated org id = stable_user_id (no storage re-key).
INSERT INTO orgs (
	id,
	slug,
	display_name,
	bio,
	avatar_key,
	profile_visibility,
	plan,
	entitlement_ladder,
	stripe_customer_id,
	stripe_plan,
	stripe_price_id,
	stripe_plan_refreshed_at,
	stripe_credits_eligible,
	admin_credits_eligible,
	second_agent_standard_gift_granted_at,
	second_agent_standard_gift_expires_at,
	referral_standard_credit_expires_at,
	signup_welcome_credits_pending,
	job_retention_success_once_days,
	job_retention_failed_once_days,
	job_retention_disabled_recurring_days,
	email_outbound_paused_at,
	suspended_at,
	created_by_user_id,
	created_at,
	updated_at
)
SELECT
	u.stable_user_id,
	LOWER(u.username),
	u.display_name,
	u.bio,
	u.avatar_key,
	COALESCE(u.profile_visibility, 'public'),
	COALESCE(u.plan, 'free'),
	COALESCE(u.entitlement_ladder, 'public'),
	u.stripe_customer_id,
	u.stripe_plan,
	u.stripe_price_id,
	u.stripe_plan_refreshed_at,
	COALESCE(u.stripe_credits_eligible, 0),
	COALESCE(u.admin_credits_eligible, 0),
	u.second_agent_standard_gift_granted_at,
	u.second_agent_standard_gift_expires_at,
	u.referral_standard_credit_expires_at,
	COALESCE(u.signup_welcome_credits_pending, 0),
	u.job_retention_success_once_days,
	u.job_retention_failed_once_days,
	u.job_retention_disabled_recurring_days,
	u.email_outbound_paused_at,
	u.suspended_at,
	CASE
		WHEN u.account_type = 'platform' THEN NULL
		ELSE u.stable_user_id
	END,
	COALESCE(u.created_at, CURRENT_TIMESTAMP),
	COALESCE(u.updated_at, CURRENT_TIMESTAMP)
FROM users u;

-- Every user is the Owner of their migrated org (platform accounts too; P8
-- adds scope-grantee owners and the @kody credit grant).
INSERT INTO org_memberships (
	org_id,
	user_id,
	role,
	invited_by_user_id,
	created_at,
	deleted_at
)
SELECT
	u.stable_user_id,
	u.stable_user_id,
	'owner',
	NULL,
	COALESCE(u.created_at, CURRENT_TIMESTAMP),
	NULL
FROM users u;

-- Shared username/org-slug namespace: one live row per user (both ids set).
INSERT INTO handles (handle, user_id, org_id, created_at)
SELECT
	LOWER(u.username),
	u.stable_user_id,
	u.stable_user_id,
	COALESCE(u.created_at, CURRENT_TIMESTAMP)
FROM users u;

-- Retired handles from username history. Skip when the name is already held
-- (someone else owns that username now).
INSERT INTO handles (handle, user_id, org_id, created_at)
SELECT
	LOWER(r.old_username),
	NULL,
	NULL,
	COALESCE(r.created_at, CURRENT_TIMESTAMP)
FROM username_redirects r
WHERE NOT EXISTS (
	SELECT 1 FROM handles h WHERE h.handle = LOWER(r.old_username)
);

-- Actor columns: today's single owner is the creator / connector / actor.
UPDATE webhook_endpoints
SET created_by_user_id = user_id
WHERE created_by_user_id IS NULL;

UPDATE user_integrations
SET connected_by_user_id = user_id
WHERE connected_by_user_id IS NULL;

UPDATE mcp_server_settings
SET connected_by_user_id = user_id
WHERE connected_by_user_id IS NULL;

-- Historical usage stays attributed to the owner (Automation split is P6).
UPDATE usage_attribution_daily
SET actor_user_id = user_id
WHERE actor_user_id IS NULL;

UPDATE usage_rollups
SET actor_user_id = user_id
WHERE actor_user_id IS NULL;

UPDATE durable_object_duration_daily
SET actor_user_id = user_id
WHERE actor_user_id IS NULL;

-- Invariants: every user has exactly one personal org and an owner membership.
DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'user missing personal org after Teams expand backfill; aborting 0089.'
WHERE EXISTS (
	SELECT 1
	FROM users u
	LEFT JOIN orgs o ON o.id = u.stable_user_id
	WHERE o.id IS NULL
);

INSERT INTO __migration_assertions (message)
SELECT 'org without owner membership after Teams expand backfill; aborting 0089.'
WHERE EXISTS (
	SELECT 1
	FROM orgs o
	LEFT JOIN org_memberships m
		ON m.org_id = o.id
		AND m.user_id = o.id
		AND m.role = 'owner'
		AND m.deleted_at IS NULL
	WHERE m.org_id IS NULL
);

INSERT INTO __migration_assertions (message)
SELECT 'user missing handles row after Teams expand backfill; aborting 0089.'
WHERE EXISTS (
	SELECT 1
	FROM users u
	LEFT JOIN handles h ON h.handle = LOWER(u.username)
	WHERE h.handle IS NULL
);

INSERT INTO __migration_assertions (message)
SELECT 'org count does not match user count after Teams expand backfill; aborting 0089.'
WHERE (SELECT COUNT(*) FROM orgs) <> (SELECT COUNT(*) FROM users);

DROP TABLE __migration_assertions;
