/**
 * Operator cost vs list-pay estimates. Unique worker-days and stored Stripe
 * price ids only — no Stripe API and no per-user usage fan-out.
 */

import { toAdminDynamicWorkerCost } from '#universal/dynamic-worker-cost.ts'
import {
	type AdminCostVsPay,
	type AdminInsightsDynamicWorkerCostConsumer,
	type AdminPaidSource,
} from '#universal/loader-data.ts'
import {
	monthlyRecurringRevenueUsdCents,
	type StripePriceCatalogEntry,
} from '#worker/billing/stripe-price-catalog.ts'

export const adminFleetCostVsPayScanLimit = 25
export const adminFleetCostVsPayDisplayLimit = 10

export function estimatePaidListMrrUsdCents(input: {
	stripePlan: string | null | undefined
	stripePriceId: string | null | undefined
	catalog: Map<string, StripePriceCatalogEntry>
}): { cents: number; source: AdminPaidSource } {
	const plan = input.stripePlan?.trim() ?? ''
	if (plan !== 'standard' && plan !== 'pro') {
		return { cents: 0, source: 'none' }
	}
	const priceId = input.stripePriceId?.trim() ?? ''
	if (!priceId) return { cents: 0, source: 'none' }
	const entry = input.catalog.get(priceId)
	if (!entry) return { cents: 0, source: 'none' }
	return {
		cents: monthlyRecurringRevenueUsdCents(entry),
		source: 'stripe_catalog',
	}
}

export function toAdminCostVsPay(input: {
	uniqueWorkerDays: number
	stripePlan: string | null | undefined
	stripePriceId: string | null | undefined
	catalog: Map<string, StripePriceCatalogEntry>
}): AdminCostVsPay {
	const cost = toAdminDynamicWorkerCost(input.uniqueWorkerDays)
	const paid = estimatePaidListMrrUsdCents(input)
	const paidUsd = paid.cents / 100
	return {
		...cost,
		estimatedPaidUsdCents: paid.cents,
		estimatedMarginUsd: paidUsd - cost.estimatedGrossUsd,
		underwater: cost.estimatedGrossUsd > paidUsd,
		paidSource: paid.source,
	}
}

export function toAdminCostVsPayConsumer(input: {
	stableUserId: string
	username: string
	uniqueWorkerDays: number
	stripePlan: string | null | undefined
	stripePriceId: string | null | undefined
	catalog: Map<string, StripePriceCatalogEntry>
}): AdminInsightsDynamicWorkerCostConsumer {
	const costVsPay = toAdminCostVsPay(input)
	return {
		stableUserId: input.stableUserId,
		username: input.username,
		uniqueWorkerDays: costVsPay.uniqueWorkerDays,
		estimatedGrossUsd: costVsPay.estimatedGrossUsd,
		estimatedPaidUsdCents: costVsPay.estimatedPaidUsdCents,
		estimatedMarginUsd: costVsPay.estimatedMarginUsd,
		underwater: costVsPay.underwater,
		paidSource: costVsPay.paidSource,
	}
}

export function rankUnderwaterCostConsumers(
	consumers: ReadonlyArray<AdminInsightsDynamicWorkerCostConsumer>,
	limit = adminFleetCostVsPayDisplayLimit,
) {
	return consumers
		.filter((consumer) => consumer.underwater)
		.toSorted(
			(left, right) =>
				right.estimatedGrossUsd -
				right.estimatedPaidUsdCents / 100 -
				(left.estimatedGrossUsd - left.estimatedPaidUsdCents / 100),
		)
		.slice(0, limit)
}
