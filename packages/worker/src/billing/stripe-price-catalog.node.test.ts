import { expect, test } from 'vitest'
import {
	retiredProPriceIds,
	retiredStandardPriceIds,
} from './billing-config.ts'
import {
	monthlyRecurringRevenueUsdCents,
	resolveStripePriceCatalog,
} from './stripe-price-catalog.ts'

test('resolveStripePriceCatalog maps the purchasable Pro and retired prices to monthly-equivalent MRR', () => {
	const catalog = resolveStripePriceCatalog({
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
	})
	const mrr = (priceId: string) =>
		monthlyRecurringRevenueUsdCents(catalog.get(priceId)!)

	expect(mrr('price_pro')).toBe(1_200)
	expect(mrr('price_pro_yearly')).toBe(1_000)
	expect(catalog.get('price_pro')?.plan).toBe('pro')
	expect(mrr(retiredStandardPriceIds[0])).toBe(1_200)
	expect(mrr(retiredStandardPriceIds[1])).toBe(1_000)
	expect(mrr(retiredStandardPriceIds[2])).toBe(500)
	expect(mrr(retiredProPriceIds[0])).toBe(4_900)
	expect(mrr(retiredProPriceIds[1])).toBe(4_000)
	expect(mrr(retiredProPriceIds[2])).toBe(2_000)
	expect(mrr(retiredProPriceIds[3])).toBe(2_900)
	expect(mrr(retiredProPriceIds[4])).toBe(2_400)
	expect(catalog.has('price_unknown')).toBe(false)
})
