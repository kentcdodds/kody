import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	type AccountCreditsLimit,
	type AccountCreditsLoaderData,
} from '#universal/loader-data.ts'
import {
	creditAutoRefillMinThresholdCents,
	creditDebitMeters,
	creditDebitRates,
	creditTopUpMaxCents,
	creditTopUpMinCents,
	creditTopUpPackCents,
} from '#universal/credits.ts'
import {
	creditsUnlockedResources,
	entitlementResourceLabels,
	resolvePlanLimit,
	resolveWeeklyPlanLimit,
	weeklyEntitlementResourceLabel,
	isWeeklyComputeWindowResource,
	type UserEntitlement,
} from '#universal/plans.ts'
import {
	getPurchasablePlans,
	isBillingConfigured,
} from '#worker/billing/billing-config.ts'
import {
	listCreditLedgerEntries,
	readCreditWallet,
	sumCreditAutoRefillCents,
	toAccountCreditsLedgerItem,
} from '#worker/billing/credit-wallet.ts'
import {
	isPayingForCreditsPro,
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'

const recentLedgerLimit = 10

/**
 * Base and unlocked numbers for the rate limits a funded wallet raises.
 * Shows numbers only; the unlocked tier has no product name. Stock is on
 * the Pro subscription base table, not listed here.
 */
export function listCreditsUnlockLimits(): Array<AccountCreditsLimit> {
	const limits: Array<AccountCreditsLimit> = []
	for (const resource of creditsUnlockedResources) {
		limits.push({
			resource,
			label: entitlementResourceLabels[resource],
			base: resolvePlanLimit('pro', resource, 'public', 'empty'),
			unlocked: resolvePlanLimit('pro', resource, 'public', 'funded'),
		})
		if (!isWeeklyComputeWindowResource(resource)) continue
		const base = resolveWeeklyPlanLimit('pro', resource, 'public', 'empty')
		const unlocked = resolveWeeklyPlanLimit('pro', resource, 'public', 'funded')
		if (base === null || unlocked === null) continue
		limits.push({
			resource: `${resource}:week`,
			label: weeklyEntitlementResourceLabel(resource),
			base,
			unlocked,
		})
	}
	return limits
}

export type AccountCreditsUser = {
	id: number
	stableUserId: string
	stripeCustomerId: string | null
	entitlement: UserEntitlement
	/** Paying for the purchasable Pro: may buy credits and auto-refill. */
	canBuyCredits: boolean
}

/** Signed-in account plus its entitlement (wallet state included). */
export async function loadAccountCreditsUser(input: {
	env: Env
	userId: number
	now?: Date
}): Promise<AccountCreditsUser | null> {
	const row = await input.env.APP_DB.prepare(
		`SELECT id, stable_user_id, stripe_customer_id, ${userEntitlementColumnsSql()}
		 FROM users WHERE id = ?`,
	)
		.bind(input.userId)
		.first<
			UserEntitlementRow & {
				id: number
				stable_user_id: string
				stripe_customer_id: string | null
			}
		>()
	if (!row) return null
	const entitlement = await resolveUserEntitlementFromRow({
		db: input.env.APP_DB,
		stableUserId: row.stable_user_id,
		row,
		now: input.now,
	})
	const stripeCustomerId = row.stripe_customer_id?.trim() || null
	return {
		id: row.id,
		stableUserId: row.stable_user_id,
		stripeCustomerId,
		entitlement,
		canBuyCredits:
			entitlement.creditWallet !== 'none' &&
			isPayingForCreditsPro(row) &&
			stripeCustomerId !== null,
	}
}

export async function loadAccountCreditsData(input: {
	env: Env
	userId: number
	notice?: string
	error?: string
	now?: Date
}): Promise<AccountCreditsLoaderData | null> {
	const now = input.now ?? new Date()
	const user = await loadAccountCreditsUser({
		env: input.env,
		userId: input.userId,
		now,
	})
	if (!user) return null
	const db = input.env.APP_DB
	const [wallet, refilledThisMonthCents, recent] = await Promise.all([
		readCreditWallet(db, user.stableUserId),
		sumCreditAutoRefillCents({
			db,
			userId: user.stableUserId,
			month: utcMonthKey(now),
		}),
		listCreditLedgerEntries({
			db,
			userId: user.stableUserId,
			limit: recentLedgerLimit,
		}),
	])
	const configured = isBillingConfigured(input.env)
	const eligible = user.entitlement.creditWallet !== 'none'
	return {
		ok: true,
		configured,
		eligible,
		plan: user.entitlement.plan,
		canSwitchToPro:
			configured && getPurchasablePlans(input.env).includes('pro'),
		canBuyCredits: configured && user.canBuyCredits,
		billingHref: '/account/billing',
		balanceMicroUsd: wallet.balanceMicroUsd,
		unlocked: user.entitlement.creditWallet === 'funded',
		packsCents: [...creditTopUpPackCents],
		customMinCents: creditTopUpMinCents,
		customMaxCents: creditTopUpMaxCents,
		autoRefill: {
			...wallet.autoRefill,
			minThresholdCents: creditAutoRefillMinThresholdCents,
			refilledThisMonthCents,
			hasPaymentMethod: Boolean(wallet.autoRefillPaymentMethodId),
		},
		notify: wallet.notify,
		limits: listCreditsUnlockLimits(),
		rates: creditDebitMeters.map((meter) => ({
			meter,
			label: creditDebitRates[meter].label,
		})),
		recent: recent.map(toAccountCreditsLedgerItem),
		...(input.notice ? { notice: input.notice } : {}),
		...(input.error ? { error: input.error } : {}),
	}
}
