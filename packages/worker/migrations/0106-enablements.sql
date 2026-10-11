-- Credentials plan v4 PR 7b: the single enablement model. Every trigger that
-- runs on its own (cron job, subscription including inbound email, webhook)
-- runs only through an enablement, as that enablement's enabler: a real
-- person who is billed and audited, and whose live access is checked on
-- every run. There is no uniqueness on (instance, enabler): one person may
-- hold several enablements of the same trigger.
--
-- instance_id is the trigger instance: the job id (cron), the webhook
-- endpoint id (webhook), or the subscribing package id (subscription, with
-- the topic in trigger_name). `off` rows are kept for audit; reads filter on
-- state. credential_mapping_json stays NULL until package credential slots
-- exist (credentials plan PR 5): a NULL mapping resolves credentials by name
-- through resolveCredential with the enabler's own Use.
CREATE TABLE IF NOT EXISTS enablements (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	package_id TEXT,
	trigger_kind TEXT NOT NULL CHECK (
		trigger_kind IN ('cron', 'subscription', 'webhook')
	),
	trigger_name TEXT NOT NULL,
	instance_id TEXT NOT NULL,
	enabler_user_id TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'on' CHECK (state IN ('on', 'paused', 'off')),
	paused_reason TEXT CHECK (
		paused_reason IS NULL
		OR paused_reason IN ('org_access', 'package_access', 'credential_access')
	),
	paused_permission TEXT,
	paused_resource_type TEXT,
	paused_resource_id TEXT,
	paused_at TEXT,
	credential_mapping_json TEXT,
	origin TEXT NOT NULL CHECK (origin IN ('enabled', 'migrated')),
	enabled_at TEXT NOT NULL,
	disabled_at TEXT,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS enablements_instance
	ON enablements (org_id, trigger_kind, instance_id)
	WHERE state <> 'off';

CREATE INDEX IF NOT EXISTS enablements_enabler
	ON enablements (enabler_user_id, org_id)
	WHERE state <> 'off';

-- The auto-enable step writes exactly one migrated row per trigger instance,
-- so an overlapping or retried run cannot add a second one.
CREATE UNIQUE INDEX IF NOT EXISTS enablements_migrated_instance
	ON enablements (org_id, trigger_kind, instance_id, trigger_name)
	WHERE origin = 'migrated';

-- Per-org migration to enablements. Only an org whose row is `migrated` runs
-- its triggers through enablements; an org with no row (or a `legacy` or
-- `notified` row) still runs them the old way until the auto-enable step
-- (`adminEnablementsMigrate`) writes its enablements and marks it
-- `migrated`. Team orgs must be `notified` (members told which enablements
-- will bill them) before they can migrate. notice_plan_json maps each
-- notified enabler to the trigger keys their notice listed, so a retried
-- notify emails nobody twice and apply refuses items nobody was told about.
CREATE TABLE IF NOT EXISTS enablement_org_migrations (
	org_id TEXT PRIMARY KEY NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('legacy', 'notified', 'migrated')),
	notice_sent_at TEXT,
	notice_plan_json TEXT,
	migrated_at TEXT,
	updated_at TEXT NOT NULL
);
