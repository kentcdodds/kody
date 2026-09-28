import { parseStoredPlanName, parseStripePlanName } from '#universal/plans.ts'
import {
	canBuyCreditsForUser,
	loadAccountUsageCredits,
} from '#app/account-credits-data.ts'
import { loadAccountUsageStory } from '#app/account-usage-story.ts'
import { isBillingConfigured } from '#worker/billing/billing-config.ts'
import { readAccountComputeOverage } from '#worker/billing/compute-overage-account.ts'
import {
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
	type AccountUsageWeekWindow,
} from '#universal/loader-data.ts'

type UsageUserRow = UserEntitlementRow & {
	id: number
	stable_user_id: string
	stripe_customer_id: string | null
}

/**
 * Signed-in user's plan, current entitlement consumption, and the Credits
 * section. One account only; cost does not grow with the user base.
 */
export async function loadAccountUsageData(input: {
	env: Env
	userId: number
	now?: Date
	notice?: string
	error?: string
}): Promise<AccountUsageLoaderData | null> {
	const now = input.now ?? new Date()
	const row = await input.env.APP_DB.prepare(
		`SELECT id, stable_user_id, stripe_customer_id, ${userEntitlementColumnsSql()}
		 FROM users WHERE id = ?`,
	)
		.bind(input.userId)
		.first<UsageUserRow>()
	if (!row) return null

	const manualPlan = parseStoredPlanName(row.plan)
	const usageUserId = resolveUserStableId(row)
	const entitlement = await resolveUserEntitlementFromRow({
		db: input.env.APP_DB,
		stableUserId: usageUserId,
		row,
		now,
	})
	const [snapshot, computeOverage] = await Promise.all([
		readEntitlementUsageSnapshot({
			db: input.env.APP_DB,
			env: input.env,
			usageUserId,
			plan: entitlement.plan,
			ladder: entitlement.ladder,
			creditWallet: entitlement.creditWallet,
			now,
		}),
		readAccountComputeOverage({
			db: input.env.APP_DB,
			stableUserId: usageUserId,
			plan: entitlement.plan,
			ladder: entitlement.ladder,
			creditWallet: entitlement.creditWallet,
			now,
		}),
	])
	const canBuyCredits = canBuyCreditsForUser({
		row,
		entitlement,
		stripeCustomerId: row.stripe_customer_id?.trim() || null,
	})
	const { credits, wallet } = await loadAccountUsageCredits({
		env: input.env,
		stableUserId: usageUserId,
		entitlement,
		canBuyCredits,
		computeOverage,
		now,
	})
	const story = await loadAccountUsageStory({
		db: input.env.APP_DB,
		stableUserId: usageUserId,
		plan: entitlement.plan,
		creditWallet: entitlement.creditWallet,
		canBuyCredits: canBuyCredits && isBillingConfigured(input.env),
		computeOverage,
		now,
		...(wallet ? { wallet } : {}),
	})

	return {
		ok: true,
		plan: snapshot.plan,
		manualPlan,
		stripePlan: parseStripePlanName(row.stripe_plan),
		today: snapshot.today,
		weekStart: snapshot.weekStart,
		entitlementConsumption: snapshot.resources.map(toAccountUsageRow),
		// Monthly include pressure is the credits alarm (`creditsAlarm`), not a
		// warning row, so the page raises it once.
		warnings: snapshot.warnings.map(toAccountUsageRow),
		computeOverage,
		canBuyCredits,
		...story,
		credits,
		...(input.notice ? { notice: input.notice } : {}),
		...(input.error ? { error: input.error } : {}),
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
