import { parseStoredPlanName, parseStripePlanName } from '#universal/plans.ts'
import {
	canBuyCreditsForUser,
	loadAccountUsageCredits,
} from '#app/account-credits-data.ts'
import { loadAccountUsageStory } from '#app/account-usage-story.ts'
import { isBillingConfigured } from '#worker/billing/billing-config.ts'
import { readCreditWallet } from '#worker/billing/credit-wallet.ts'
import { reconcileSignupWelcomeCreditsIfPending } from '#worker/billing/signup-welcome-credits.ts'
import { readAccountComputeOverage } from '#worker/billing/compute-overage-account.ts'
import {
	resolveUserEntitlementFromRow,
	resolveUserPlanFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { readEntitlementUsageSnapshot } from '#worker/entitlements/usage-snapshot.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	type AccountUsageEntitlementConsumption,
	type AccountUsageLoaderData,
	type AccountUsageWeekWindow,
} from '#universal/loader-data.ts'
import { loadCreditAttributionBreakdown } from '#worker/usage/credit-attribution.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import { getOrgById } from '#worker/orgs/repo.ts'

type UsageUserRow = UserEntitlementRow & {
	id: number
	stable_user_id: string
	username: string
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
		`SELECT id, stable_user_id, username, stripe_customer_id, ${userEntitlementColumnsSql()}
		 FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.userId)
		.first<UsageUserRow>()
	if (!row) return null

	const manualPlan = parseStoredPlanName(row.plan)
	const usageUserId = ownerIdFromStored(row.stable_user_id)
	// Best-effort: retry a creation-time welcome grant that failed earlier.
	// No-ops unless signup_welcome_credits_pending is set (no pre-ship backfill).
	await reconcileSignupWelcomeCreditsIfPending({
		db: input.env.APP_DB,
		userId: usageUserId,
		now,
	})
	const { creditsEligible } = resolveUserPlanFromRow(row, now)
	// One credit_wallets read for entitlement balance + Credits section.
	const wallet = creditsEligible
		? await readCreditWallet(input.env.APP_DB, usageUserId)
		: null
	const entitlement = await resolveUserEntitlementFromRow({
		db: input.env.APP_DB,
		stableUserId: usageUserId,
		row,
		now,
		...(wallet ? { balanceMicroUsd: wallet.balanceMicroUsd } : {}),
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
	const signupOrg = await getOrgById(input.env.APP_DB, usageUserId)
	const billingHref = orgBillingPath(signupOrg?.slug?.trim() || row.username)
	const { credits, wallet: creditsWallet } = await loadAccountUsageCredits({
		env: input.env,
		stableUserId: usageUserId,
		entitlement,
		canBuyCredits,
		computeOverage,
		now,
		billingHref,
		...(wallet ? { wallet } : {}),
	})
	const [story, whereItWent] = await Promise.all([
		loadAccountUsageStory({
			db: input.env.APP_DB,
			stableUserId: usageUserId,
			plan: entitlement.plan,
			creditWallet: entitlement.creditWallet,
			canBuyCredits: canBuyCredits && isBillingConfigured(input.env),
			computeOverage,
			now,
			...(creditsWallet ? { wallet: creditsWallet } : {}),
		}),
		loadCreditAttributionBreakdown({
			db: input.env.APP_DB,
			stableUserId: usageUserId,
			username: row.username,
			computeOverage,
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
		// Monthly include pressure is the credits alarm (`creditsAlarm`), not a
		// warning row, so the page raises it once.
		warnings: snapshot.warnings.map(toAccountUsageRow),
		computeOverage,
		canBuyCredits,
		...story,
		whereItWent,
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
