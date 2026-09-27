import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	type AccountCreditsDebitMeter,
	type AccountCreditsLimit,
	type AccountCreditsLoaderData,
} from '#universal/loader-data.ts'
import {
	creditAutoRefillMinThresholdCents,
	creditDebitCostMicroUsd,
	creditDebitMeters,
	creditDebitRates,
	creditTopUpMaxCents,
	creditTopUpMinCents,
	creditTopUpPackCents,
} from '#universal/credits.ts'
import { isCustomerFacingComputeMeter } from '#universal/compute-overage.ts'
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
import { readAccountComputeOverage } from '#worker/billing/compute-overage-account.ts'
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
 * The Pro include and how far credits can carry usage past it, for the rate
 * limits credits apply to. Numbers only, framed as a ceiling on credits (not
 * a tier a balance unlocks). Stock is on the Pro subscription, not listed.
 */
export function listCreditsCeilingLimits(): Array<AccountCreditsLimit> {
	const limits: Array<AccountCreditsLimit> = []
	for (const resource of creditsUnlockedResources) {
		limits.push({
			resource,
			label: entitlementResourceLabels[resource],
			included: resolvePlanLimit('pro', resource, 'public', 'empty'),
			creditsCeiling: resolvePlanLimit('pro', resource, 'public', 'funded'),
		})
		if (!isWeeklyComputeWindowResource(resource)) continue
		const included = resolveWeeklyPlanLimit('pro', resource, 'public', 'empty')
		const creditsCeiling = resolveWeeklyPlanLimit(
			'pro',
			resource,
			'public',
			'funded',
		)
		if (included === null || creditsCeiling === null) continue
		limits.push({
			resource: `${resource}:week`,
			label: weeklyEntitlementResourceLabel(resource),
			included,
			creditsCeiling,
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
	const [wallet, refilledThisMonthCents, recent, computeOverage] =
		await Promise.all([
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
			readAccountComputeOverage({
				db,
				stableUserId: user.stableUserId,
				plan: user.entitlement.plan,
				ladder: user.entitlement.ladder,
				creditWallet: user.entitlement.creditWallet,
				now,
			}).catch(() => null),
		])
	const configured = isBillingConfigured(input.env)
	const eligible = user.entitlement.creditWallet !== 'none'
	const rates = creditDebitMeters
		.filter((meter) => isCustomerFacingComputeMeter(meter))
		.map((meter) => ({
			meter,
			label: creditDebitRates[meter].label,
		}))
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
		hasCredits: user.entitlement.creditWallet === 'funded',
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
		limits: listCreditsCeilingLimits(),
		rates,
		debitMeters: computeOverage
			? toCreditsDebitMeters(computeOverage.meters)
			: [],
		recent: recent.map(toAccountCreditsLedgerItem),
		...(input.notice ? { notice: input.notice } : {}),
		...(input.error ? { error: input.error } : {}),
	}
}

/**
 * Rate-card rows for the credits page. Reuses the same meters as
 * `/account/usage` — never invent a second path or a CPU debit.
 */
export function toCreditsDebitMeters(
	meters: Array<{
		resource: string
		label: string
		current: number
		include: number
		percentOfLimit: number
	}>,
): Array<AccountCreditsDebitMeter> {
	const rows: Array<AccountCreditsDebitMeter> = []
	for (const meter of meters) {
		if (!isCustomerFacingComputeMeter(meter.resource)) continue
		const pastInclude = Math.max(0, meter.current - meter.include)
		rows.push({
			meter: meter.resource,
			label: meter.label,
			unitRateLabel: creditDebitRates[meter.resource].label,
			include: meter.include,
			used: meter.current,
			pastInclude,
			percentOfInclude: meter.percentOfLimit,
			estCreditsMicroUsd: creditDebitCostMicroUsd(meter.resource, pastInclude),
		})
	}
	return rows
}
