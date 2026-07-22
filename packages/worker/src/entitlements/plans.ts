/**
 * Plan definitions and per-plan resource limits.
 *
 * First-class plans include `unlimited`. New writers always persist a plan
 * name (never NULL). During stage 1, reads stay dual-compatible: stored NULL
 * and unknown strings still parse as null and retain historical fail-open
 * behavior (no ordinary entitlement enforcement). Enforcement activates for
 * recognized plan names from `planNames`.
 */

export const planNames = ['free', 'partner', 'pro', 'unlimited'] as const

export type PlanName = (typeof planNames)[number]

export function parsePlanName(value: unknown): PlanName | null {
	return typeof value === 'string' &&
		(planNames as ReadonlyArray<string>).includes(value)
		? (value as PlanName)
		: null
}

/**
 * Parse a plan name that may come from Stripe metadata or `users.stripe_plan`.
 * `unlimited` is never purchasable or Stripe-sourced.
 */
export function parseStripePlanName(value: unknown): PlanName | null {
	const plan = parsePlanName(value)
	return plan === 'unlimited' ? null : plan
}

/**
 * Coerce admin/API nullish plan inputs to the first-class `unlimited` plan.
 * Production writers must never persist NULL.
 */
export function resolvePlanWrite(plan: PlanName | null | undefined): PlanName {
	return plan ?? 'unlimited'
}

/**
 * Rank order for comparing manual grants vs Stripe subscription plans.
 * Higher rank wins. free(0) < pro(1) < partner(2) < unlimited(3).
 */
export function getPlanRank(plan: PlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'pro':
			return 1
		case 'partner':
			return 2
		case 'unlimited':
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
 * - Manual plan NULL → effective NULL (stage-1 dual-read fail-open; a Stripe
 *   subscription never downgrades a stored-NULL account into enforcement).
 * - Manual `unlimited` always wins over any Stripe plan.
 * - Otherwise the higher-ranked of manual and stripe plans.
 * - Unknown/NULL/`unlimited` stripe_plan contributes nothing.
 */
export function resolveEffectivePlan(
	manualPlan: PlanName | null,
	stripePlan: string | null,
): PlanName | null {
	if (!manualPlan) return null
	if (manualPlan === 'unlimited') return 'unlimited'
	const parsedStripe = parseStripePlanName(stripePlan)
	if (!parsedStripe) return manualPlan
	return getPlanRank(parsedStripe) > getPlanRank(manualPlan)
		? parsedStripe
		: manualPlan
}

export type PlanLimits = {
	/** Maximum saved packages (rows in saved_packages). null = unlimited. */
	maxSavedPackages: number | null
	/** Maximum scheduled jobs (rows in jobs). null = unlimited. */
	maxScheduledJobs: number | null
	/** Maximum concurrently running package services. null = unlimited. */
	maxPackageServices: number | null
	/** Whether services declared with mode 'persistent' may be started. */
	packageServicePersistentAllowed: boolean
	/** Maximum active repo sessions (repo_sessions with status 'active'). */
	maxRepoSessions: number | null
	/** Maximum outbound email send attempts per UTC day. */
	maxEmailSendsPerDay: number | null
	/** Maximum stored inbound email receipts per UTC day. */
	maxEmailReceivesPerDay: number | null
	/** Maximum stored email messages (rows in email_messages). */
	maxStoredEmailMessages: number | null
	/**
	 * Maximum raw MIME bytes for a single stored email message. Hard
	 * platform bound: raw MIME lives in EMAIL_BLOBS, but extracted text/html
	 * bodies are still stored on the email_messages row (worst case ~2x
	 * raw), and D1 caps rows at 2 MB — so keep this well under ~1 MB
	 * regardless of plan.
	 */
	maxEmailMessageBytes: number | null
	/** Maximum stored secret entries across non-expired buckets. */
	maxSecrets: number | null
	/** Maximum durable storage bytes. Defined but not yet enforced. */
	maxStorageBytes: number | null
	/** Maximum concurrently active workflow runs. */
	maxConcurrentWorkflows: number | null
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
 * Fallback limits for users without a plan on the email resources.
 *
 * Email is abuse-sensitive in both directions — inbound volume is
 * attacker-controlled (anyone can send to a `{username}@<platform domain>`
 * address) and outbound sending is an outreach-abuse surface — so unlike
 * other resources stored NULL / unknown strings during stage 1 do not mean
 * uncapped mail here: accounts without a recognized plan and the explicit
 * `unlimited` plan get these deployment-level backstops instead. The receive
 * and storage numbers sit between the `free` and `pro` plan limits; the send
 * backstop sits between `free` and `pro` send limits as well.
 *
 * The first-class `unlimited` plan uses these same numbers as its email
 * limits so new accounts match historical stored-NULL email behavior.
 */
export const nullPlanEmailFallbackLimits = {
	email_sends_per_day: 100,
	email_receives_per_day: 200,
	stored_email_messages: 2000,
	email_message_bytes: 512 * 1024,
} as const satisfies Partial<Record<EntitlementResource, number>>

export type EmailFallbackResource = keyof typeof nullPlanEmailFallbackLimits

/**
 * Initial limit numbers are conservative placeholders chosen before usage
 * metering exists. They are expected to be tuned once metering data is
 * available. Billing (packages/worker/src/billing/) maps Stripe
 * subscriptions onto these plan names but the limit numbers stay
 * independent of pricing.
 */
export const planLimits: Record<PlanName, PlanLimits> = {
	free: {
		maxSavedPackages: 5,
		maxScheduledJobs: 3,
		maxPackageServices: 1,
		packageServicePersistentAllowed: false,
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
		packageServicePersistentAllowed: true,
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
		packageServicePersistentAllowed: true,
		maxRepoSessions: 40,
		maxEmailSendsPerDay: 500,
		maxEmailReceivesPerDay: 2000,
		maxStoredEmailMessages: 25_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 200,
		maxStorageBytes: 5 * 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 100,
	},
	unlimited: {
		maxSavedPackages: null,
		maxScheduledJobs: null,
		maxPackageServices: null,
		packageServicePersistentAllowed: true,
		maxRepoSessions: null,
		maxEmailSendsPerDay: nullPlanEmailFallbackLimits.email_sends_per_day,
		maxEmailReceivesPerDay: nullPlanEmailFallbackLimits.email_receives_per_day,
		maxStoredEmailMessages: nullPlanEmailFallbackLimits.stored_email_messages,
		maxEmailMessageBytes: nullPlanEmailFallbackLimits.email_message_bytes,
		maxSecrets: null,
		maxStorageBytes: null,
		// null so assertWithinEntitlement falls through to the env workflow
		// concurrency backstop (same behavior as historical stored-NULL users).
		maxConcurrentWorkflows: null,
	},
}

export function isEmailFallbackResource(
	resource: EntitlementResource,
): resource is EmailFallbackResource {
	return resource in nullPlanEmailFallbackLimits
}

/**
 * Resolve the effective limit for an inbound email resource: the plan limit
 * when the user has a recognized plan, otherwise the email backstop.
 */
export function resolveEmailResourceLimit(
	plan: PlanName | null,
	resource: EmailFallbackResource,
): number | null {
	return plan
		? resolvePlanLimit(plan, resource)
		: nullPlanEmailFallbackLimits[resource]
}

/**
 * Resolve the numeric limit for a resource under a plan. null = unlimited.
 * Boolean allowances are expressed as limit 0 (not allowed) vs null
 * (allowed) so every enforcement point uses the same numeric contract.
 */
export function resolvePlanLimit(
	plan: PlanName,
	resource: EntitlementResource,
): number | null {
	const limits = planLimits[plan]
	switch (resource) {
		case 'saved_packages':
			return limits.maxSavedPackages
		case 'scheduled_jobs':
			return limits.maxScheduledJobs
		case 'package_services':
			return limits.maxPackageServices
		case 'persistent_package_services':
			return limits.packageServicePersistentAllowed ? null : 0
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
