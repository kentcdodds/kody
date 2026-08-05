import {
	parseStoredPlanName,
	resolveEffectivePlan,
} from '#worker/entitlements/plans.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
} from './loader-data.ts'

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
	const snapshot = await readEntitlementUsageSnapshot({
		db: input.env.APP_DB,
		env: input.env,
		usageUserId,
		plan,
		now,
	})

	return {
		ok: true,
		plan: snapshot.plan,
		today: snapshot.today,
		entitlementConsumption: snapshot.resources.map(toAccountUsageRow),
		warnings: snapshot.warnings.map(toAccountUsageRow),
	}
}

function toAccountUsageRow(
	row: Awaited<
		ReturnType<typeof readEntitlementUsageSnapshot>
	>['resources'][number],
): AccountUsageEntitlementConsumption {
	return {
		resource: row.resource,
		label: row.label,
		group: row.group,
		kind: row.kind,
		whatCounts: row.whatCounts,
		howToReduce: row.howToReduce,
		current: row.current,
		limit: row.limit,
		percentOfLimit: row.percentOfLimit,
		overEightyPercent: row.overEightyPercent,
	}
}
