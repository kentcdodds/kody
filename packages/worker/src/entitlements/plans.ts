/**
 * Plan definitions and per-plan resource limits.
 *
 * `users.plan` is nullable: NULL means legacy/unlimited and disables all
 * entitlement enforcement for that user. Enforcement only activates when a
 * plan name from `planNames` is set. Unknown stored values are treated as
 * NULL (unlimited) so adding or renaming plans never locks users out.
 */

export const planNames = ['partner', 'personal', 'pro'] as const

export type PlanName = (typeof planNames)[number]

export function parsePlanName(value: unknown): PlanName | null {
	return typeof value === 'string' &&
		(planNames as ReadonlyArray<string>).includes(value)
		? (value as PlanName)
		: null
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
	/** Maximum stored secret entries across non-expired buckets. */
	maxSecrets: number | null
	/** Maximum durable storage bytes. Defined but not yet enforced. */
	maxStorageBytes: number | null
	/** Maximum concurrently active workflow runs. */
	maxConcurrentWorkflows: number | null
}

/**
 * Initial limit numbers are conservative placeholders chosen before usage
 * metering exists. They are expected to be tuned once metering data is
 * available, and are deliberately not tied to any billing integration.
 */
export const planLimits: Record<PlanName, PlanLimits> = {
	personal: {
		maxSavedPackages: 20,
		maxScheduledJobs: 10,
		maxPackageServices: 2,
		packageServicePersistentAllowed: false,
		maxRepoSessions: 5,
		maxEmailSendsPerDay: 20,
		maxSecrets: 20,
		maxStorageBytes: 256 * 1024 * 1024,
		maxConcurrentWorkflows: 10,
	},
	pro: {
		maxSavedPackages: 100,
		maxScheduledJobs: 50,
		maxPackageServices: 10,
		packageServicePersistentAllowed: true,
		maxRepoSessions: 20,
		maxEmailSendsPerDay: 200,
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
		maxSecrets: 200,
		maxStorageBytes: 5 * 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 100,
	},
}

export const entitlementResources = [
	'saved_packages',
	'scheduled_jobs',
	'package_services',
	'persistent_package_services',
	'repo_sessions',
	'email_sends_per_day',
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
	secrets: 'secrets',
	storage_bytes: 'storage bytes',
	concurrent_workflows: 'concurrent workflows',
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
