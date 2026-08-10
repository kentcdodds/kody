import {
	entitlementResourceLabels,
	resolvePlanLimit,
	type EntitlementResource,
	type PlanName,
} from '#universal/plans.ts'
import { readCurrentEntitlementResourceUsage } from '#worker/entitlements/service.ts'
import { type AdminUsageEntitlementConsumption } from '#universal/loader-data.ts'

export const adminEntitlementResources = [
	'saved_packages',
	'scheduled_jobs',
	'package_services',
	'persistent_package_services',
	'repo_sessions',
	'email_sends_per_day',
	'email_receives_per_day',
	'stored_email_messages',
	'secrets',
	'concurrent_workflows',
	'execute_calls_per_day',
	'outbound_fetches_per_day',
	'job_runs_per_day',
	'storage_bytes',
] as const satisfies ReadonlyArray<EntitlementResource>

export const entitlementWarningThreshold = 0.8

/**
 * Current entitlement consumption for one account. `storage_bytes` is read from
 * UserMeter via `readCurrentEntitlementResourceUsage`, matching the signed-in
 * account usage page.
 */
export async function readAdminEntitlementConsumption(input: {
	env: Env
	usageUserId: string
	plan: PlanName
	now: Date
}): Promise<Array<AdminUsageEntitlementConsumption>> {
	return await Promise.all(
		adminEntitlementResources.map(async (resource) => {
			const current = await readCurrentEntitlementResourceUsage({
				db: input.env.APP_DB,
				env: input.env,
				userId: input.usageUserId,
				resource,
				now: input.now,
			})
			const limit = resolvePlanLimit(input.plan, resource)
			const percentOfLimit = limit === 0 ? null : current / limit
			return {
				resource,
				label: entitlementResourceLabels[resource],
				current,
				limit,
				percentOfLimit,
				overEightyPercent:
					percentOfLimit !== null &&
					percentOfLimit > entitlementWarningThreshold,
			}
		}),
	)
}
