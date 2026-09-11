import { expect, test } from 'vitest'
import {
	estimatePaidListMrrUsdCents,
	rankUnderwaterCostConsumers,
	toAdminCostVsPay,
	toAdminCostVsPayConsumer,
} from './cost-vs-pay.ts'
import { resolveStripePriceCatalog } from '#worker/billing/stripe-price-catalog.ts'

const catalog = resolveStripePriceCatalog({
	STRIPE_STANDARD_PRICE_ID: 'price_standard',
	STRIPE_STANDARD_YEARLY_PRICE_ID: 'price_standard_yearly',
	STRIPE_PRO_PRICE_ID: 'price_pro',
	STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
})

test('estimatePaidListMrrUsdCents uses catalog list MRR and treats overlays as $0', () => {
	expect(
		estimatePaidListMrrUsdCents({
			stripePlan: 'standard',
			stripePriceId: 'price_standard',
			catalog,
		}),
	).toEqual({ cents: 1_200, source: 'stripe_catalog' })
	expect(
		estimatePaidListMrrUsdCents({
			stripePlan: 'pro',
			stripePriceId: 'price_pro_yearly',
			catalog,
		}),
	).toEqual({ cents: 4_000, source: 'stripe_catalog' })
	expect(
		estimatePaidListMrrUsdCents({
			stripePlan: null,
			stripePriceId: 'price_standard',
			catalog,
		}),
	).toEqual({ cents: 0, source: 'none' })
	expect(
		estimatePaidListMrrUsdCents({
			stripePlan: 'standard',
			stripePriceId: 'price_unknown',
			catalog,
		}),
	).toEqual({ cents: 0, source: 'none' })
})

test('toAdminCostVsPay flags underwater when gross worker-day cost exceeds list pay', () => {
	const freeHeavy = toAdminCostVsPay({
		uniqueWorkerDays: 1_500,
		stripePlan: null,
		stripePriceId: null,
		catalog,
	})
	expect(freeHeavy.estimatedGrossUsd).toBe(3)
	expect(freeHeavy.estimatedPaidUsdCents).toBe(0)
	expect(freeHeavy.estimatedMarginUsd).toBe(-3)
	expect(freeHeavy.underwater).toBe(true)
	expect(freeHeavy.paidSource).toBe('none')

	const paidLight = toAdminCostVsPay({
		uniqueWorkerDays: 90,
		stripePlan: 'standard',
		stripePriceId: 'price_standard',
		catalog,
	})
	expect(paidLight.estimatedGrossUsd).toBe(0.18)
	expect(paidLight.estimatedPaidUsdCents).toBe(1_200)
	expect(paidLight.underwater).toBe(false)
	expect(paidLight.paidSource).toBe('stripe_catalog')
})

test('rankUnderwaterCostConsumers sorts by deficit and keeps the display bound', () => {
	const ranked = rankUnderwaterCostConsumers(
		[
			toAdminCostVsPayConsumer({
				stableUserId: 'paid',
				username: 'paid',
				uniqueWorkerDays: 90,
				stripePlan: 'pro',
				stripePriceId: 'price_pro',
				catalog,
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'small',
				username: 'small',
				uniqueWorkerDays: 100,
				stripePlan: null,
				stripePriceId: null,
				catalog,
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'big',
				username: 'big',
				uniqueWorkerDays: 2_000,
				stripePlan: null,
				stripePriceId: null,
				catalog,
			}),
		],
		2,
	)
	expect(ranked.map((row) => row.stableUserId)).toEqual(['big', 'small'])
})
