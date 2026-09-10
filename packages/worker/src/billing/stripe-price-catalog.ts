/**
 * Known Stripe list prices for admin MRR. Checkout amounts live here so
 * insights can turn `users.stripe_price_id` into monthly-equivalent revenue
 * without calling Stripe on the request path.
 */

import {
	getProPriceId,
	getProYearlyPriceId,
	getStandardPriceId,
	getStandardYearlyPriceId,
	retiredProPriceIds,
	retiredStandardPriceIds,
	type BillingInterval,
	type BillingEnv,
	type PurchasablePlan,
} from './billing-config.ts'

export type StripePriceCatalogEntry = {
	priceId: string
	plan: PurchasablePlan
	interval: BillingInterval
	/** Recurring list price in USD cents for `interval`. */
	amountUsdCents: number
}

const publicStandardMonthlyUsdCents = 1_200
const publicStandardYearlyUsdCents = 12_000
const publicProMonthlyUsdCents = 4_900
const publicProYearlyUsdCents = 48_000

const retiredPriceCatalog: ReadonlyArray<StripePriceCatalogEntry> = [
	{
		priceId: retiredStandardPriceIds[0],
		plan: 'standard',
		interval: 'month',
		amountUsdCents: 500,
	},
	{
		priceId: retiredProPriceIds[0],
		plan: 'pro',
		interval: 'month',
		amountUsdCents: 2_000,
	},
	{
		priceId: retiredProPriceIds[1],
		plan: 'pro',
		interval: 'month',
		amountUsdCents: 2_900,
	},
	{
		priceId: retiredProPriceIds[2],
		plan: 'pro',
		interval: 'year',
		amountUsdCents: 28_800,
	},
]

export function monthlyRecurringRevenueUsdCents(
	entry: StripePriceCatalogEntry,
): number {
	switch (entry.interval) {
		case 'month':
			return entry.amountUsdCents
		case 'year':
			return Math.round(entry.amountUsdCents / 12)
		default: {
			const exhaustive: never = entry.interval
			throw new Error(`Unknown billing interval: ${String(exhaustive)}`)
		}
	}
}

function addCatalogEntry(
	byPriceId: Map<string, StripePriceCatalogEntry>,
	entry: StripePriceCatalogEntry,
) {
	const priceId = entry.priceId.trim()
	if (!priceId) return
	byPriceId.set(priceId, { ...entry, priceId })
}

/**
 * Map configured plus retired Standard/Pro price ids to list price and
 * interval. Unknown ids (metadata-only grants) are absent so MRR can skip
 * them instead of inventing a number.
 */
export function resolveStripePriceCatalog(
	env: BillingEnv,
): Map<string, StripePriceCatalogEntry> {
	const byPriceId = new Map<string, StripePriceCatalogEntry>()
	for (const entry of retiredPriceCatalog) {
		addCatalogEntry(byPriceId, entry)
	}
	addCatalogEntry(byPriceId, {
		priceId: getStandardPriceId(env) ?? '',
		plan: 'standard',
		interval: 'month',
		amountUsdCents: publicStandardMonthlyUsdCents,
	})
	addCatalogEntry(byPriceId, {
		priceId: getStandardYearlyPriceId(env) ?? '',
		plan: 'standard',
		interval: 'year',
		amountUsdCents: publicStandardYearlyUsdCents,
	})
	addCatalogEntry(byPriceId, {
		priceId: getProPriceId(env) ?? '',
		plan: 'pro',
		interval: 'month',
		amountUsdCents: publicProMonthlyUsdCents,
	})
	addCatalogEntry(byPriceId, {
		priceId: getProYearlyPriceId(env) ?? '',
		plan: 'pro',
		interval: 'year',
		amountUsdCents: publicProYearlyUsdCents,
	})
	return byPriceId
}
