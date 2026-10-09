-- Teams P3 expand: §3.2 org primitives (APP_DB). Additive only. Migrated orgs
-- reuse users.stable_user_id so storage keys do not move. Backfill is 0089.

CREATE TABLE orgs (
	id TEXT PRIMARY KEY NOT NULL,
	slug TEXT NOT NULL UNIQUE,
	display_name TEXT,
	bio TEXT,
	avatar_key TEXT,
	profile_visibility TEXT NOT NULL DEFAULT 'public'
		CHECK (profile_visibility IN ('public', 'private')),
	plan TEXT NOT NULL DEFAULT 'free'
		CHECK (plan IN ('free', 'standard', 'pro', 'max')),
	entitlement_ladder TEXT NOT NULL DEFAULT 'public'
		CHECK (entitlement_ladder IN ('public', 'legacy')),
	stripe_customer_id TEXT,
	stripe_plan TEXT,
	stripe_price_id TEXT,
	stripe_plan_refreshed_at TEXT,
	stripe_credits_eligible INTEGER NOT NULL DEFAULT 0
		CHECK (stripe_credits_eligible IN (0, 1)),
	admin_credits_eligible INTEGER NOT NULL DEFAULT 0
		CHECK (admin_credits_eligible IN (0, 1)),
	second_agent_standard_gift_granted_at TEXT,
	second_agent_standard_gift_expires_at TEXT,
	referral_standard_credit_expires_at TEXT,
	signup_welcome_credits_pending INTEGER NOT NULL DEFAULT 0
		CHECK (signup_welcome_credits_pending IN (0, 1)),
	default_user_budget_micro_usd INTEGER,
	automation_budget_micro_usd INTEGER,
	access_epoch INTEGER NOT NULL DEFAULT 0,
	job_retention_success_once_days INTEGER
		CHECK (
			job_retention_success_once_days IS NULL
			OR (
				job_retention_success_once_days >= 1
				AND job_retention_success_once_days <= 365
			)
		),
	job_retention_failed_once_days INTEGER
		CHECK (
			job_retention_failed_once_days IS NULL
			OR (
				job_retention_failed_once_days >= 1
				AND job_retention_failed_once_days <= 365
			)
		),
	job_retention_disabled_recurring_days INTEGER
		CHECK (
			job_retention_disabled_recurring_days IS NULL
			OR (
				job_retention_disabled_recurring_days >= 1
				AND job_retention_disabled_recurring_days <= 365
			)
		),
	email_outbound_paused_at TEXT,
	suspended_at TEXT,
	deleted_at TEXT,
	deleting_at TEXT,
	created_by_user_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_orgs_stripe_customer_id ON orgs (stripe_customer_id)
	WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE handles (
	handle TEXT PRIMARY KEY NOT NULL,
	user_id TEXT,
	org_id TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE org_memberships (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'billing')),
	invited_by_user_id TEXT,
	created_at TEXT NOT NULL,
	deleted_at TEXT,
	PRIMARY KEY (org_id, user_id)
);

CREATE TABLE teams (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	slug TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT,
	parent_team_id TEXT CHECK (parent_team_id IS NULL),
	created_by_user_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	UNIQUE (org_id, slug)
);

CREATE TABLE team_members (
	team_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	added_by_user_id TEXT,
	created_at TEXT NOT NULL,
	deleted_at TEXT,
	PRIMARY KEY (team_id, user_id)
);

CREATE TABLE grants (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	resource_type TEXT NOT NULL CHECK (
		resource_type IN (
			'package',
			'app',
			'job',
			'secret',
			'integration',
			'memory',
			'email',
			'org'
		)
	),
	resource_id TEXT NOT NULL,
	subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'team')),
	subject_id TEXT NOT NULL,
	preset TEXT CHECK (preset IN ('use', 'contribute', 'manage')),
	created_by_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);

CREATE UNIQUE INDEX grants_live_subject ON grants (
	resource_type,
	resource_id,
	subject_type,
	subject_id
) WHERE deleted_at IS NULL;

CREATE INDEX grants_subject ON grants (subject_type, subject_id)
	WHERE deleted_at IS NULL;

CREATE TABLE grant_permissions (
	grant_id TEXT NOT NULL,
	permission TEXT NOT NULL,
	PRIMARY KEY (grant_id, permission)
);

-- Name is free: 0058 dropped the legacy invites table.
CREATE TABLE invites (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('membership', 'grant')),
	role TEXT,
	team_ids_json TEXT,
	resource_type TEXT,
	resource_id TEXT,
	permissions_json TEXT,
	preset TEXT,
	invitee_email TEXT,
	invitee_username TEXT,
	token_hash TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL CHECK (
		status IN ('pending', 'accepted', 'revoked', 'expired')
	),
	invited_by_user_id TEXT NOT NULL,
	accepted_by_user_id TEXT,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	accepted_at TEXT
);

CREATE TABLE access_cache (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	compiled_json TEXT NOT NULL,
	computed_at TEXT NOT NULL,
	PRIMARY KEY (org_id, user_id)
);

CREATE TABLE org_user_budgets (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	monthly_budget_micro_usd INTEGER NOT NULL,
	set_by_user_id TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	PRIMARY KEY (org_id, user_id)
);
