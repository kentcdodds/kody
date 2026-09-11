import { expect, test } from 'vitest'
import {
	retiredProPriceIds,
	retiredStandardPriceIds,
} from './billing-config.ts'
import {
	monthlyRecurringRevenueUsdCents,
	resolveStripePriceCatalog,
} from './stripe-price-catalog.ts'

test('resolveStripePriceCatalog maps public and retired prices to monthly-equivalent MRR', () => {
	const catalog = resolveStripePriceCatalog({
		STRIPE_STANDARD_PRICE_ID: 'price_standard',
		STRIPE_STANDARD_YEARLY_PRICE_ID: 'price_standard_yearly',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
	})

	expect(monthlyRecurringRevenueUsdCents(catalog.get('price_standard')!)).toBe(
		1_200,
	)
	expect(
		monthlyRecurringRevenueUsdCents(catalog.get('price_standard_yearly')!),
	).toBe(1_000)
	expect(monthlyRecurringRevenueUsdCents(catalog.get('price_pro')!)).toBe(4_900)
	expect(
		monthlyRecurringRevenueUsdCents(catalog.get('price_pro_yearly')!),
	).toBe(4_000)
	expect(
		monthlyRecurringRevenueUsdCents(catalog.get(retiredStandardPriceIds[0])!),
	).toBe(500)
	expect(
		monthlyRecurringRevenueUsdCents(catalog.get(retiredProPriceIds[0])!),
	).toBe(2_000)
	expect(
		monthlyRecurringRevenueUsdCents(catalog.get(retiredProPriceIds[1])!),
	).toBe(2_900)
	expect(
		monthlyRecurringRevenueUsdCents(catalog.get(retiredProPriceIds[2])!),
	).toBe(2_400)
	expect(catalog.has('price_unknown')).toBe(false)
})
