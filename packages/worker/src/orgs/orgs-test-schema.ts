/**
 * Minimal Teams expand tables for worker tests that start from an empty D1.
 */
export async function ensureOrgsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS orgs (
				id TEXT PRIMARY KEY NOT NULL,
				slug TEXT NOT NULL UNIQUE,
				display_name TEXT,
				bio TEXT,
				avatar_key TEXT,
				profile_visibility TEXT NOT NULL DEFAULT 'public',
				plan TEXT NOT NULL DEFAULT 'free',
				entitlement_ladder TEXT NOT NULL DEFAULT 'public',
				stripe_customer_id TEXT,
				stripe_plan TEXT,
				stripe_price_id TEXT,
				stripe_plan_refreshed_at TEXT,
				stripe_credits_eligible INTEGER NOT NULL DEFAULT 0,
				admin_credits_eligible INTEGER NOT NULL DEFAULT 0,
				second_agent_standard_gift_granted_at TEXT,
				second_agent_standard_gift_expires_at TEXT,
				referral_standard_credit_expires_at TEXT,
				signup_welcome_credits_pending INTEGER NOT NULL DEFAULT 0,
				job_retention_success_once_days INTEGER,
				job_retention_failed_once_days INTEGER,
				job_retention_disabled_recurring_days INTEGER,
				email_outbound_paused_at TEXT,
				suspended_at TEXT,
				deleted_at TEXT,
				deleting_at TEXT,
				created_by_user_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_memberships (
				org_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				role TEXT NOT NULL,
				invited_by_user_id TEXT,
				created_at TEXT NOT NULL,
				deleted_at TEXT,
				PRIMARY KEY (org_id, user_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS handles (
				handle TEXT PRIMARY KEY NOT NULL,
				user_id TEXT,
				org_id TEXT,
				created_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS grants (
				id TEXT PRIMARY KEY NOT NULL,
				org_id TEXT NOT NULL,
				resource_type TEXT NOT NULL,
				resource_id TEXT NOT NULL,
				subject_type TEXT NOT NULL,
				subject_id TEXT NOT NULL,
				preset TEXT,
				created_by_user_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				deleted_at TEXT
			)`,
		)
		.run()
}
