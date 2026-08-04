/**
 * Plan definitions and per-plan resource limits.
 *
 * First-class plans include `max`. Writers persist a plan name (never NULL).
 * After the plan CHECK constraints, reads resolve stored values to
 * {@link PlanName} via strict {@link parseStoredPlanName}. Unexpected values
 * indicate schema corruption and throw instead of granting a plan. Untrusted
 * admin/API input uses {@link parsePlanName} so invalid input can be rejected
 * without throwing. Stripe metadata uses {@link parseStripePlanName}, which
 * rejects `max` (manual-only) and residual `'unlimited'`.
 *
 * Follow-up: emergency admin-only `unlimited` is intentionally deferred until
 * a follow-up deployment after 0083's residual sweep. Until then the live
 * registry is finite `max` only.
 */

export const planNames = ['free', 'partner', 'pro', 'max'] as const

export type PlanName = (typeof planNames)[number]

/**
 * Strict plan-name parser for untrusted admin/API input validation.
 * Unknown strings, typos, residual `'unlimited'`, nullish values, and
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
 * Parse a plan name that may come from Stripe metadata or `users.stripe_plan`.
 * `max` is manual-only (never purchasable or Stripe-sourced). Residual
 * `'unlimited'` is also rejected. `stripe_plan` stays nullable; unknown /
 * null / `max` / `'unlimited'` values contribute nothing.
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
 * Higher rank wins. free(0) < pro(1) < partner(2) < max(3).
 */
export function getPlanRank(plan: PlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'pro':
			return 1
		case 'partner':
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
 * - Unknown/NULL/`max`/residual `'unlimited'` stripe_plan contributes nothing.
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
	/**
	 * Finite 0/1 gate for services declared with mode `persistent`.
	 * 0 = not allowed; 1 = allowed.
	 */
	packageServicePersistentAllowed: number
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
}

/**
 * Inherited abuse caps for the first-class `max` plan. Email is
 * abuse-sensitive in both directions — inbound volume is
 * attacker-controlled (anyone can send to a `{username}@<platform domain>`
 * address) and outbound sending is an outreach-abuse surface — so `max` is
 * not uncapped for mail. These are intentional abuse backstops (not the
 * ordinary 100×-pro derivation used for other max ceilings) and sit between
 * the `free` and `pro` plan email limits.
 */
export const maxPlanEmailLimits = {
	email_sends_per_day: 100,
	email_receives_per_day: 200,
	stored_email_messages: 2_000,
	email_message_bytes: 512 * 1024,
} as const satisfies Partial<Record<EntitlementResource, number>>

export type MaxPlanEmailResource = keyof typeof maxPlanEmailLimits

/**
 * Initial limit numbers are conservative placeholders chosen before usage
 * metering exists. They are expected to be tuned once metering data is
 * available. Billing (packages/worker/src/billing/) maps Stripe
 * subscriptions onto these plan names but the limit numbers stay
 * independent of pricing.
 *
 * Ordinary `max` ceilings are an explicit product choice: 100× the
 * corresponding `pro` limit (exact product for integer counters; storage
 * uses 100× of pro's 1 GiB → 100 GiB). Email resources intentionally use
 * {@link maxPlanEmailLimits} abuse caps instead.
 */
export const planLimits: Record<PlanName, PlanLimits> = {
	// Free is deliberately generous on *counts* and unchanged on *rates*.
	//
	// Counts (packages, jobs, secrets, repo sessions) are close to free to
	// serve — a handful of D1 rows — and they are exactly what stands between
	// someone and the moment the product makes sense, which is the second or
	// third automation rather than the first. Rates and long-lived compute
	// (execute calls, outbound fetches, inbound mail, workflows, services) are
	// the real cost and abuse surfaces and stay where they were.
	//
	// The old ceilings ran out during setup rather than after conviction. Five
	// secrets is the clearest case: one OAuth integration commonly needs three
	// (client secret, access token, refresh token), so five allowed barely one
	// and a half integrations on a product whose whole point is holding
	// credentials safely.
	free: {
		maxRepos: 20,
		maxSavedPackages: 25,
		maxScheduledJobs: 10,
		// Long-lived compute. Unchanged, and persistent services stay off.
		maxPackageServices: 1,
		packageServicePersistentAllowed: 0,
		maxRepoSessions: 5,
		// notify-self and reply-to-stored only, so the outreach-abuse surface
		// is small; a daily digest plus a few alerts should not hit the wall.
		maxEmailSendsPerDay: 10,
		// Inbound volume is attacker-controlled. Unchanged.
		maxEmailReceivesPerDay: 50,
		maxStoredEmailMessages: 500,
		maxEmailMessageBytes: 256 * 1024,
		maxSecrets: 15,
		maxStorageBytes: 64 * 1024 * 1024,
		// Compute. Unchanged.
		maxConcurrentWorkflows: 3,
		// The primary cost meter. Unchanged.
		maxExecuteCallsPerDay: 500,
		maxOutboundFetchesPerDay: 2_000,
	},
	pro: {
		maxRepos: 200,
		maxSavedPackages: 100,
		maxScheduledJobs: 50,
		maxPackageServices: 10,
		packageServicePersistentAllowed: 1,
		maxRepoSessions: 20,
		maxEmailSendsPerDay: 200,
		maxEmailReceivesPerDay: 1000,
		maxStoredEmailMessages: 10_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 100,
		maxStorageBytes: 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 50,
		maxExecuteCallsPerDay: 5_000,
		maxOutboundFetchesPerDay: 20_000,
	},
	partner: {
		maxRepos: 400,
		maxSavedPackages: 200,
		maxScheduledJobs: 100,
		maxPackageServices: 20,
		packageServicePersistentAllowed: 1,
		maxRepoSessions: 40,
		maxEmailSendsPerDay: 500,
		maxEmailReceivesPerDay: 2000,
		maxStoredEmailMessages: 25_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 200,
		maxStorageBytes: 5 * 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 100,
		maxExecuteCallsPerDay: 10_000,
		maxOutboundFetchesPerDay: 40_000,
	},
	max: {
		// 100× pro (200) → 20_000; product placeholder uses 10_000 per spec.
		maxRepos: 10_000,
		// 100× pro (100) → 10_000.
		maxSavedPackages: 10_000,
		// 100× pro (50) → 5_000.
		maxScheduledJobs: 5_000,
		// 100× pro (10) → 1_000.
		maxPackageServices: 1_000,
		// Same finite 0/1 gate as pro (1 = persistent services allowed).
		packageServicePersistentAllowed: 1,
		// 100× pro (20) → 2_000.
		maxRepoSessions: 2_000,
		// Inherited abuse caps (not 100× pro); see maxPlanEmailLimits.
		maxEmailSendsPerDay: maxPlanEmailLimits.email_sends_per_day,
		maxEmailReceivesPerDay: maxPlanEmailLimits.email_receives_per_day,
		maxStoredEmailMessages: maxPlanEmailLimits.stored_email_messages,
		maxEmailMessageBytes: maxPlanEmailLimits.email_message_bytes,
		// 100× pro (100) → 10_000.
		maxSecrets: 10_000,
		// 100× pro (1 GiB) → 100 GiB.
		maxStorageBytes: 100 * 1024 * 1024 * 1024,
		// 100× pro (50) → 5_000 (explicit product choice).
		maxConcurrentWorkflows: 5_000,
		// 100× pro (5_000) → 500_000.
		maxExecuteCallsPerDay: 500_000,
		// 100× pro (20_000) → 2_000_000.
		maxOutboundFetchesPerDay: 2_000_000,
	},
}

export function isMaxPlanEmailResource(
	resource: EntitlementResource,
): resource is MaxPlanEmailResource {
	return resource in maxPlanEmailLimits
}

/**
 * Resolve the effective limit for an email resource under a plan. The
 * `max` plan uses {@link maxPlanEmailLimits} as its email caps; other plans
 * use their ordinary plan limits.
 */
export function resolveEmailResourceLimit(
	plan: PlanName,
	resource: MaxPlanEmailResource,
): number {
	return resolvePlanLimit(plan, resource)
}

/**
 * Resolve the numeric limit for a resource under a plan. Every plan limit
 * is finite. Boolean-style allowances (persistent services) are expressed
 * as a 0/1 gate so every enforcement point uses the same numeric contract.
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
			return limits.packageServicePersistentAllowed
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
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown entitlement resource: ${String(exhaustive)}`)
		}
	}
}
