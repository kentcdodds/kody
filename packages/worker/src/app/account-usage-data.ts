import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	entitlementResourceLabels,
	parseStoredPlanName,
	resolveEffectivePlan,
	resolvePlanLimit,
	type EntitlementResource,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import { readCurrentEntitlementResourceUsage } from '#worker/entitlements/service.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
} from './loader-data.ts'

const accountUsageEntitlementResources = [
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
	'storage_bytes',
] as const satisfies ReadonlyArray<EntitlementResource>

const warningThreshold = 0.8

type UsageUserRow = {
	id: number
	plan: string
	stripe_plan: string | null
	stable_user_id: string
}

/**
 * Signed-in user's plan and current entitlement consumption. One account only;
 * cost does not grow with the user base.
 */
export async function loadAccountUsageData(input: {
	env: Env
	userId: number
	now?: Date
}): Promise<AccountUsageLoaderData | null> {
	const now = input.now ?? new Date()
	const row = await input.env.APP_DB.prepare(
		`SELECT id, plan, stripe_plan, stable_user_id FROM users WHERE id = ?`,
	)
		.bind(input.userId)
		.first<UsageUserRow>()
	if (!row) return null

	const plan = resolveEffectivePlan(
		parseStoredPlanName(row.plan),
		row.stripe_plan,
	)
	const usageUserId = resolveUserStableId(row)
	const entitlementConsumption = await readEntitlementConsumption({
		env: input.env,
		usageUserId,
		plan,
		now,
	})

	return {
		ok: true,
		plan,
		today: utcDayKey(now),
		entitlementConsumption,
		warnings: entitlementConsumption.filter((item) => item.overEightyPercent),
	}
}

async function readEntitlementConsumption(input: {
	env: Env
	usageUserId: string
	plan: PlanName
	now: Date
}): Promise<Array<AccountUsageEntitlementConsumption>> {
	return await Promise.all(
		accountUsageEntitlementResources.map(async (resource) => {
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
					percentOfLimit !== null && percentOfLimit > warningThreshold,
			}
		}),
	)
}
