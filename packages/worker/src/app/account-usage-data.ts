import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	computeMonthlyOverage,
	computeOverageBillingPolicy,
	computeOverageIncludePercent,
	computeOverageWarningResourceLabels,
	resolveComputeOverageDisposition,
} from '#universal/compute-overage.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	parseStripePlanName,
	resolveEffectivePlan,
} from '#universal/plans.ts'
import { readMonthlyComputeUsage } from '#worker/billing/compute-overage-usage.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	type AccountUsageComputeOverage,
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
} from '#universal/loader-data.ts'

type UsageUserRow = {
	id: number
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	stable_user_id: string
	stripe_customer_id: string | null
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
			stripe_customer_id
		 FROM users WHERE id = ?`,
	)
		.bind(input.userId)
		.first<UsageUserRow>()
	if (!row) return null

	const manualPlan = parseStoredPlanName(row.plan)
	const plan = resolveEffectivePlan(manualPlan, row.stripe_plan)
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
		loadAccountComputeOverage({
			env: input.env,
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
		entitlementConsumption: snapshot.resources.map(toAccountUsageRow),
		warnings: snapshot.warnings.map(toAccountUsageRow),
		computeOverage,
	}
}

async function loadAccountComputeOverage(input: {
	env: Env
	userId: number
	stableUserId: string
	plan: ReturnType<typeof resolveEffectivePlan>
	ladder: ReturnType<typeof parseEntitlementLadder>
	hasStripeCustomer: boolean
	now: Date
}): Promise<AccountUsageComputeOverage> {
	const month = utcMonthKey(input.now)
	const [usage, chargingEnabled] = await Promise.all([
		readMonthlyComputeUsage({
			db: input.env.APP_DB,
			stableUserId: input.stableUserId,
			month,
		}),
		isFeatureEnabled(
			input.env.APP_DB,
			'compute-overage-charging',
			input.userId,
		),
	])
	const overage = computeMonthlyOverage({
		plan: input.plan,
		ladder: input.ladder,
		uniqueWorkerDays: usage.uniqueWorkerDays,
		durableObjectRowsRead: usage.durableObjectRowsRead,
	})
	const uniqueWorkerDayPercent =
		computeOverageIncludePercent(
			usage.uniqueWorkerDays,
			overage.includedUniqueWorkerDays,
		) ?? 0
	const durableObjectRowsReadPercent =
		computeOverageIncludePercent(
			usage.durableObjectRowsRead,
			overage.includedDurableObjectRowsRead,
		) ?? 0
	return {
		meters: [
			{
				resource: 'unique_worker_days',
				label: computeOverageWarningResourceLabels.unique_worker_days,
				current: usage.uniqueWorkerDays,
				include: overage.includedUniqueWorkerDays,
				percentOfLimit: uniqueWorkerDayPercent,
				overEightyPercent: uniqueWorkerDayPercent >= 0.8,
			},
			{
				resource: 'durable_object_rows_read',
				label: computeOverageWarningResourceLabels.durable_object_rows_read,
				current: usage.durableObjectRowsRead,
				include: overage.includedDurableObjectRowsRead,
				percentOfLimit: durableObjectRowsReadPercent,
				overEightyPercent: durableObjectRowsReadPercent >= 0.8,
			},
		],
		disposition: resolveComputeOverageDisposition({
			plan: input.plan,
			ladder: input.ladder,
			overage,
			hasStripeCustomer: input.hasStripeCustomer,
			chargingEnabled,
			policy: computeOverageBillingPolicy,
		}),
		totalCents: overage.totalCents,
		chargingEnabled,
		hasStripeCustomer: input.hasStripeCustomer,
		legacyUnbilled: overage.legacyUnbilled,
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
