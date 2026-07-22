/**
 * Plan definitions and per-plan resource limits.
 *
 * First-class plans include `max`. Writers persist a plan name (never NULL).
 * After `users.plan` NOT NULL, reads resolve stored values to {@link PlanName}
 * via {@link parseStoredPlanName}: known names are unchanged; unexpected
 * NULL / unknown strings / residual stored `'unlimited'` fail open to `max`
 * with a stable console.warn. Untrusted admin/API input still uses strict
 * {@link parsePlanName} so typos and residual `'unlimited'` are rejected
 * rather than coerced. Stripe metadata uses {@link parseStripePlanName},
 * which rejects `max` (manual-only) and residual `'unlimited'`.
 *
 * Follow-up: emergency admin-only `unlimited` is intentionally deferred until
 * a follow-up deployment after 0083's residual sweep. Until then the live
 * registry is finite `max` only.
 */

export const planNames = ['free', 'partner', 'pro', 'max'] as const

export type PlanName = (typeof planNames)[number]

/**
 * Stable console.warn tag when {@link parseStoredPlanName} coerces an
 * unexpected NULL, unknown stored string, or residual `'unlimited'` to
 * `max`. Never include user identifiers or the raw stored value in the warn
 * arguments.
 */
export const unknownStoredPlanWarningTag = 'entitlement-unknown-stored-plan'

/**
 * Strict plan-name parser for untrusted admin/API input validation.
 * Unknown strings, typos, residual `'unlimited'`, nullish values, and
 * non-strings return null so callers can reject them. Do not use this for
 * reading stored `users.plan` / `invites.plan` columns — use
 * {@link parseStoredPlanName} instead.
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
 * Unlike {@link parsePlanName} (strict validation for untrusted admin/API
 * input — typos, unknown strings, and residual `'unlimited'` stay null so
 * writers can reject them), this helper always returns a {@link PlanName}:
 * known names are unchanged; defensive unexpected NULL, unknown stored
 * strings, and residual `'unlimited'` fail open to `max` and emit
 * {@link unknownStoredPlanWarningTag} with no user data.
 */
export function parseStoredPlanName(value: unknown): PlanName {
	const plan = parsePlanName(value)
	if (plan) return plan
	console.warn(unknownStoredPlanWarningTag)
	return 'max'
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
	/** Maximum stored email messages (rows in email_messages). */
	maxStoredEmailMessages: number
	/**
	 * Maximum raw MIME bytes for a single stored email message. Hard
	 * platform bound: raw MIME lives in EMAIL_BLOBS, but extracted text/html
	 * bodies are still stored on the email_messages row (worst case ~2x
	 * raw), and D1 caps rows at 2 MB — so keep this well under ~1 MB
	 * regardless of plan.
	 */
	maxEmailMessageBytes: number
	/** Maximum stored secret entries across non-expired buckets. */
	maxSecrets: number
	/** Maximum durable storage bytes across enforced storage surfaces. */
	maxStorageBytes: number
	/** Maximum concurrently active workflow runs. */
	maxConcurrentWorkflows: number
}

export const entitlementResources = [
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
] as const

export type EntitlementResource = (typeof entitlementResources)[number]

/** Human-readable resource labels used in the shared error message. */
export const entitlementResourceLabels: Record<EntitlementResource, string> = {
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
	free: {
		maxSavedPackages: 5,
		maxScheduledJobs: 3,
		maxPackageServices: 1,
		packageServicePersistentAllowed: 0,
		maxRepoSessions: 2,
		maxEmailSendsPerDay: 5,
		maxEmailReceivesPerDay: 50,
		maxStoredEmailMessages: 500,
		maxEmailMessageBytes: 256 * 1024,
		maxSecrets: 5,
		maxStorageBytes: 64 * 1024 * 1024,
		maxConcurrentWorkflows: 3,
	},
	pro: {
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
	},
	partner: {
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
	},
	max: {
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
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown entitlement resource: ${String(exhaustive)}`)
		}
	}
}
