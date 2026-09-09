import {
	parseEntitlementLadder,
	parseStoredPlanName,
	parseStripePlanName,
} from '#universal/plans.ts'
import { laterIsoTimestamp } from '#universal/referral-program.ts'
import { resolveEffectivePlanWithSecondAgentGift } from '#universal/second-agent-standard-gift.ts'
import {
	computeOverageUsageWarningRows,
	readAccountComputeOverage,
} from '#worker/billing/compute-overage-account.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
	type AccountUsageWeekWindow,
} from '#universal/loader-data.ts'

type UsageUserRow = {
	id: number
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	stable_user_id: string
	stripe_customer_id: string | null
	second_agent_standard_gift_expires_at: string | null
	referral_standard_credit_expires_at: string | null
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
		`SELECT id, plan, stripe_plan, entitlement_ladder, stable_user_id,
			stripe_customer_id, second_agent_standard_gift_expires_at,
			referral_standard_credit_expires_at
		 FROM users WHERE id = ?`,
	)
		.bind(input.userId)
		.first<UsageUserRow>()
	if (!row) return null

	const manualPlan = parseStoredPlanName(row.plan)
	const plan = resolveEffectivePlanWithSecondAgentGift(
		manualPlan,
		row.stripe_plan,
		laterIsoTimestamp(
			row.second_agent_standard_gift_expires_at,
			row.referral_standard_credit_expires_at,
		),
		now,
	)
	const ladder = parseEntitlementLadder(row.entitlement_ladder)
	const usageUserId = resolveUserStableId(row)
	const [snapshot, computeOverage] = await Promise.all([
		readEntitlementUsageSnapshot({
			db: input.env.APP_DB,
			env: input.env,
			usageUserId,
			plan,
			ladder,
			now,
		}),
		readAccountComputeOverage({
			db: input.env.APP_DB,
			userId: row.id,
			stableUserId: usageUserId,
			plan,
			ladder,
			hasStripeCustomer: Boolean(row.stripe_customer_id?.trim()),
			now,
		}),
	])

	return {
		ok: true,
		plan: snapshot.plan,
		manualPlan,
		stripePlan: parseStripePlanName(row.stripe_plan),
		today: snapshot.today,
		weekStart: snapshot.weekStart,
		entitlementConsumption: snapshot.resources.map(toAccountUsageRow),
		warnings: [
			...computeOverageUsageWarningRows(computeOverage).map(toAccountUsageRow),
			...snapshot.warnings.map(toAccountUsageRow),
		],
		computeOverage,
	}
}

function toAccountUsageRow(row: {
	resource: string
	label: string
	group: AccountUsageEntitlementConsumption['group']
	kind: AccountUsageEntitlementConsumption['kind']
	whatCounts: string
	howToReduce: string
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
	week?: AccountUsageWeekWindow
}): AccountUsageEntitlementConsumption {
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
		...(row.week ? { week: row.week } : {}),
	}
}
