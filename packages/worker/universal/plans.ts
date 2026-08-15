/**
 * Plan definitions and per-plan resource limits.
 *
 * First-class plans include `max`. Writers persist a plan name (never NULL).
 * After the plan CHECK constraints, reads resolve stored values to
 * {@link PlanName} via strict {@link parseStoredPlanName}. Unexpected values
 * indicate schema corruption and throw instead of granting a plan. Untrusted
 * admin/API input uses {@link parsePlanName} so invalid input can be rejected
 * without throwing. Stripe metadata uses {@link parseStripePlanName}, which
 * rejects `max` (manual-only).
 *
 * There is deliberately no uncapped plan: the live registry is finite `max`
 * only.
 */

export const planNames = ['free', 'standard', 'pro', 'max'] as const

export type PlanName = (typeof planNames)[number]

/**
 * Strict plan-name parser for untrusted admin/API input validation.
 * Unknown strings, typos, retired plan names, nullish values, and
 * non-strings return null so callers can reject them.
 */
export function parsePlanName(value: unknown): PlanName | null {
	return typeof value === 'string' &&
		(planNames as ReadonlyArray<string>).includes(value)
		? (value as PlanName)
		: null
}

/**
 * Parse a plan value read from a stored `users.plan` (or equivalent) column.
 *
 * Unlike {@link parsePlanName}, which returns null for expected invalid
 * untrusted input, this helper throws when persisted data violates the schema
 * contract. The error deliberately omits the raw value and user identifiers.
 */
export function parseStoredPlanName(value: unknown): PlanName {
	const plan = parsePlanName(value)
	if (plan) return plan
	throw new Error('Stored plan is not a registered plan name.')
}

/**
 * Parse a plan name that may come from Stripe subscription metadata
 * (`kody_plan`) or `users.stripe_plan`. `max` is manual-only (never
 * purchasable or Stripe-sourced); unknown values contribute nothing.
 */
export function parseStripePlanName(value: unknown): PlanName | null {
	const plan = parsePlanName(value)
	return plan === 'max' ? null : plan
}

/**
 * Coerce admin/API nullish plan inputs to the default `free` plan used for
 * normal creation and reset paths (signup, invites, admin/platform seeds).
 * Production writers must never persist NULL. Explicit `max` remains a
 * valid deliberate assignment.
 */
export function resolvePlanWrite(plan: PlanName | null | undefined): PlanName {
	return plan ?? 'free'
}

/**
 * Rank order for comparing manual grants vs Stripe subscription plans.
 * Higher rank wins. free(0) < standard(1) < pro(2) < max(3).
 */
export function getPlanRank(plan: PlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'standard':
			return 1
		case 'pro':
			return 2
		case 'max':
			return 3
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown plan: ${String(exhaustive)}`)
		}
	}
}

/**
 * Effective plan for entitlement enforcement.
 *
 * - Manual arg is a non-null {@link PlanName} (callers resolve stored values
 *   with {@link parseStoredPlanName} first).
 * - Higher-ranked of manual and stripe plans wins (`max` ranks highest).
 * - Unknown, NULL, `max`, or retired stripe_plan values contribute nothing.
 */
export function resolveEffectivePlan(
	manualPlan: PlanName,
	stripePlan: string | null,
): PlanName {
	const parsedStripe = parseStripePlanName(stripePlan)
	if (!parsedStripe) return manualPlan
	return getPlanRank(parsedStripe) > getPlanRank(manualPlan)
		? parsedStripe
		: manualPlan
}

export type PlanLimits = {
	/** Maximum plain repos (rows in user_repos). */
	maxRepos: number
	/** Maximum saved packages (rows in saved_packages). */
	maxSavedPackages: number
	/** Maximum scheduled jobs (rows in jobs). */
	maxScheduledJobs: number
	/** Maximum concurrently running package services. */
	maxPackageServices: number
	/** Maximum concurrently running services declared with mode `persistent`. */
	maxPersistentPackageServices: number
	/** Maximum active repo sessions (repo_sessions with status 'active'). */
	maxRepoSessions: number
	/** Maximum outbound email send attempts per UTC day. */
	maxEmailSendsPerDay: number
	/** Maximum stored inbound email receipts per UTC day. */
	maxEmailReceivesPerDay: number
	/** Maximum stored email messages (Mailbox DO email_messages rows). */
	maxStoredEmailMessages: number
	/**
	 * Maximum raw MIME bytes for a single stored email message. Hard
	 * platform bound: raw MIME lives in EMAIL_BLOBS, but extracted text/html
	 * bodies are still stored on the Mailbox email_messages row (worst case
	 * ~2x raw), and SQLite rows cap at 2 MB — so keep this well under ~1 MB
	 * regardless of plan.
	 */
	maxEmailMessageBytes: number
	/** Maximum stored secret entries across non-expired buckets. */
	maxSecrets: number
	/** Maximum durable storage bytes across enforced storage surfaces. */
	maxStorageBytes: number
	/** Maximum concurrently active workflow runs. */
	maxConcurrentWorkflows: number
	/** Maximum MCP execute-tool runs per UTC day. */
	maxExecuteCallsPerDay: number
	/**
	 * Maximum sandbox outbound fetches (through the fetch gateway) per UTC
	 * day. Bounds cost abuse and third-party hammering from user code; the
	 * shared Worker egress identity means one user's fetch flood can burn
	 * reputation for the whole deployment.
	 */
	maxOutboundFetchesPerDay: number
	/**
	 * Maximum scheduled-job executions per UTC day (cron, interval, and
	 * run-now). Separate from `maxScheduledJobs` (how many job rows you may
	 * own) so a handful of minutely jobs cannot burn unbounded compute.
	 */
	maxJobRunsPerDay: number
}

export const entitlementResources = [
	'repos',
	'saved_packages',
	'scheduled_jobs',
	'package_services',
	'persistent_package_services',
	'repo_sessions',
	'email_sends_per_day',
	'email_receives_per_day',
	'stored_email_messages',
	'email_message_bytes',
	'secrets',
	'storage_bytes',
	'concurrent_workflows',
	'execute_calls_per_day',
	'outbound_fetches_per_day',
	'job_runs_per_day',
] as const

export type EntitlementResource = (typeof entitlementResources)[number]

/** Human-readable resource labels used in the shared error message. */
export const entitlementResourceLabels: Record<EntitlementResource, string> = {
	repos: 'repos',
	saved_packages: 'saved packages',
	scheduled_jobs: 'scheduled jobs',
	package_services: 'running package services',
	persistent_package_services: 'persistent package services',
	repo_sessions: 'active repo sessions',
	email_sends_per_day: 'email sends per day',
	email_receives_per_day: 'email receives per day',
	stored_email_messages: 'stored email messages',
	email_message_bytes: 'bytes per email message',
	secrets: 'secrets',
	storage_bytes: 'storage bytes',
	concurrent_workflows: 'concurrent workflows',
	execute_calls_per_day: 'execute calls per day',
	outbound_fetches_per_day: 'outbound fetches per day',
	job_runs_per_day: 'job runs per day',
}

/**
 * Email caps for the first-class `max` plan. Email is abuse-sensitive in
 * both directions — inbound volume is attacker-controlled (anyone can send
 * to a `{username}@<platform domain>` address) and outbound sending is an
 * outreach-abuse surface — so `max` is not uncapped for mail. These are
 * intentional abuse backstops (not the ordinary 100×-pro derivation used
 * for other max ceilings), but they dominate every other plan's email
 * limits so granting `max` never reduces a user's email capacity.
 * `email_message_bytes` is pinned to standard/pro parity because the
 * per-message ceiling is a platform bound (see the PlanLimits field doc),
 * not a scalable quota.
 */
export const maxPlanEmailLimits = {
	email_sends_per_day: 10_000,
	email_receives_per_day: 20_000,
	stored_email_messages: 100_000,
	email_message_bytes: 768 * 1024,
} as const satisfies Partial<Record<EntitlementResource, number>>

/**
 * Initial limit numbers are conservative placeholders chosen before usage
 * metering exists. They are expected to be tuned once metering data is
 * available. Billing (packages/worker/src/billing/) maps Stripe
 * subscriptions onto these plan names but the limit numbers stay
 * independent of pricing.
 *
 * Ordinary `max` ceilings are explicit product choices based on the new
 * `pro` plan. Most retain the previous ceilings even where that is 25× or
 * 50× pro rather than a uniform multiplier. Email resources intentionally
 * use {@link maxPlanEmailLimits} abuse caps instead.
 */
export const planLimits: Record<PlanName, PlanLimits> = {
	// Free stays roomy for setup (packages, secrets, a handful of jobs) and
	// tighter on rates / live compute — the real cost and the upgrade story.
	// Secrets stay at 25 because one OAuth integration commonly needs three
	// entries (client secret, access token, refresh token).
	free: {
		maxRepos: 20,
		maxSavedPackages: 15,
		maxScheduledJobs: 5,
		// Long-lived compute. Persistent services stay off.
		maxPackageServices: 1,
		maxPersistentPackageServices: 0,
		// Sessions are cheap (D1 row + dormant DO workspace + Artifacts
		// branch). Unused (never-checkpointed) leftovers sweep after 30
		// minutes idle; edited sessions keep the 7-day window so unpublished
		// work is not lost mid-conversation. Sized for a few agent
		// conversations, not dozens.
		maxRepoSessions: 15,
		// notify-self and reply-to-stored only, so the outreach-abuse surface
		// is small; a daily digest plus a few alerts should not hit the wall.
		maxEmailSendsPerDay: 10,
		// Inbound volume is attacker-controlled. Unchanged.
		maxEmailReceivesPerDay: 50,
		maxStoredEmailMessages: 500,
		maxEmailMessageBytes: 256 * 1024,
		maxSecrets: 25,
		maxStorageBytes: 16 * 1024 * 1024,
		// Concurrent active runs (not lifetime or daily).
		maxConcurrentWorkflows: 2,
		maxExecuteCallsPerDay: 250,
		maxOutboundFetchesPerDay: 1_000,
		maxJobRunsPerDay: 500,
	},
	standard: {
		maxRepos: 200,
		maxSavedPackages: 100,
		maxScheduledJobs: 50,
		maxPackageServices: 10,
		maxPersistentPackageServices: 1,
		maxRepoSessions: 200,
		maxEmailSendsPerDay: 200,
		maxEmailReceivesPerDay: 1_000,
		maxStoredEmailMessages: 10_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 100,
		maxStorageBytes: 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 50,
		maxExecuteCallsPerDay: 5_000,
		maxOutboundFetchesPerDay: 20_000,
		maxJobRunsPerDay: 10_000,
	},
	pro: {
		maxRepos: 400,
		maxSavedPackages: 200,
		maxScheduledJobs: 150,
		maxPackageServices: 20,
		maxPersistentPackageServices: 3,
		maxRepoSessions: 400,
		maxEmailSendsPerDay: 500,
		maxEmailReceivesPerDay: 2_000,
		maxStoredEmailMessages: 25_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 200,
		maxStorageBytes: 5 * 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 100,
		maxExecuteCallsPerDay: 10_000,
		maxOutboundFetchesPerDay: 40_000,
		maxJobRunsPerDay: 20_000,
	},
	max: {
		// 25× pro (400) → 10_000.
		maxRepos: 10_000,
		// 50× pro (200) → 10_000.
		maxSavedPackages: 10_000,
		// Product ceiling (about 33× pro).
		maxScheduledJobs: 5_000,
		// 50× pro (20) → 1_000.
		maxPackageServices: 1_000,
		// Product ceiling for no-duration-cap service runs.
		maxPersistentPackageServices: 10,
		// 50× pro (400) → 20_000.
		maxRepoSessions: 20_000,
		// Inherited abuse caps (not 100× pro); see maxPlanEmailLimits.
		maxEmailSendsPerDay: maxPlanEmailLimits.email_sends_per_day,
		maxEmailReceivesPerDay: maxPlanEmailLimits.email_receives_per_day,
		maxStoredEmailMessages: maxPlanEmailLimits.stored_email_messages,
		maxEmailMessageBytes: maxPlanEmailLimits.email_message_bytes,
		// 50× pro (200) → 10_000.
		maxSecrets: 10_000,
		// 20× pro (5 GiB) → 100 GiB.
		maxStorageBytes: 100 * 1024 * 1024 * 1024,
		// 50× pro (100) → 5_000.
		maxConcurrentWorkflows: 5_000,
		// 50× pro (10_000) → 500_000.
		maxExecuteCallsPerDay: 500_000,
		// 50× pro (40_000) → 2_000_000.
		maxOutboundFetchesPerDay: 2_000_000,
		// 50× pro (20_000) → 1_000_000.
		maxJobRunsPerDay: 1_000_000,
	},
}

/**
 * Resolve the numeric limit for a resource under a plan. Every plan limit
 * is finite, including persistent-service concurrency counts.
 */
export function resolvePlanLimit(
	plan: PlanName,
	resource: EntitlementResource,
): number {
	const limits = planLimits[plan]
	switch (resource) {
		case 'repos':
			return limits.maxRepos
		case 'saved_packages':
			return limits.maxSavedPackages
		case 'scheduled_jobs':
			return limits.maxScheduledJobs
		case 'package_services':
			return limits.maxPackageServices
		case 'persistent_package_services':
			return limits.maxPersistentPackageServices
		case 'repo_sessions':
			return limits.maxRepoSessions
		case 'email_sends_per_day':
			return limits.maxEmailSendsPerDay
		case 'email_receives_per_day':
			return limits.maxEmailReceivesPerDay
		case 'stored_email_messages':
			return limits.maxStoredEmailMessages
		case 'email_message_bytes':
			return limits.maxEmailMessageBytes
		case 'secrets':
			return limits.maxSecrets
		case 'storage_bytes':
			return limits.maxStorageBytes
		case 'concurrent_workflows':
			return limits.maxConcurrentWorkflows
		case 'execute_calls_per_day':
			return limits.maxExecuteCallsPerDay
		case 'outbound_fetches_per_day':
			return limits.maxOutboundFetchesPerDay
		case 'job_runs_per_day':
			return limits.maxJobRunsPerDay
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown entitlement resource: ${String(exhaustive)}`)
		}
	}
}
