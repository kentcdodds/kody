import { expect, test } from 'vitest'
import {
	classifyAdminCostRisk,
	estimatePaidListMrrUsdCents,
	isOperatorCostNoise,
	rankRiskCostConsumers,
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

test('toAdminCostVsPay buckets real risk instead of every unpaid penny', () => {
	const freePennies = toAdminCostVsPay({
		uniqueWorkerDays: 90,
		stripePlan: null,
		stripePriceId: null,
		catalog,
		manualPlan: 'free',
		username: 'cara',
	})
	expect(freePennies.estimatedGrossUsd).toBe(0.18)
	expect(freePennies.estimatedPaidUsdCents).toBe(0)
	expect(freePennies.underwater).toBe(false)
	expect(freePennies.risk).toBe('none')
	expect(freePennies.paidSource).toBe('none')

	const freeNearAllotment = toAdminCostVsPay({
		uniqueWorkerDays: 500,
		stripePlan: null,
		stripePriceId: null,
		catalog,
		manualPlan: 'free',
		username: 'climber',
	})
	expect(freeNearAllotment.estimatedGrossUsd).toBe(1)
	expect(freeNearAllotment.underwater).toBe(false)
	expect(freeNearAllotment.risk).toBe('free_near_allotment')

	const freePastAllotment = toAdminCostVsPay({
		uniqueWorkerDays: 1_500,
		stripePlan: null,
		stripePriceId: null,
		catalog,
		manualPlan: 'free',
		username: 'heavy',
	})
	expect(freePastAllotment.estimatedGrossUsd).toBe(3)
	expect(freePastAllotment.underwater).toBe(false)
	expect(freePastAllotment.risk).toBe('free_near_allotment')

	const paidLight = toAdminCostVsPay({
		uniqueWorkerDays: 90,
		stripePlan: 'standard',
		stripePriceId: 'price_standard',
		catalog,
		manualPlan: 'free',
		username: 'paid-light',
	})
	expect(paidLight.estimatedGrossUsd).toBe(0.18)
	expect(paidLight.estimatedPaidUsdCents).toBe(1_200)
	expect(paidLight.underwater).toBe(false)
	expect(paidLight.risk).toBe('none')
	expect(paidLight.paidSource).toBe('stripe_catalog')

	const paidUnderwater = toAdminCostVsPay({
		uniqueWorkerDays: 7_000,
		stripePlan: 'standard',
		stripePriceId: 'price_standard',
		catalog,
		manualPlan: 'free',
		username: 'paid-heavy',
	})
	expect(paidUnderwater.estimatedGrossUsd).toBe(14)
	expect(paidUnderwater.estimatedPaidUsdCents).toBe(1_200)
	expect(paidUnderwater.underwater).toBe(true)
	expect(paidUnderwater.risk).toBe('paid_underwater')

	const missingPriceId = toAdminCostVsPay({
		uniqueWorkerDays: 481,
		stripePlan: 'standard',
		stripePriceId: null,
		catalog,
		manualPlan: 'free',
		username: 'maciek',
	})
	expect(missingPriceId.estimatedGrossUsd).toBe(0.962)
	expect(missingPriceId.estimatedPaidUsdCents).toBe(0)
	expect(missingPriceId.underwater).toBe(false)
	expect(missingPriceId.risk).toBe('missing_price_id')
	expect(missingPriceId.paidSource).toBe('none')

	const giftStandardPennies = toAdminCostVsPay({
		uniqueWorkerDays: 481,
		stripePlan: null,
		stripePriceId: null,
		catalog,
		manualPlan: 'standard',
		username: 'gifted',
	})
	expect(giftStandardPennies.risk).toBe('none')
	expect(giftStandardPennies.underwater).toBe(false)

	const giftStandardNearAllotment = toAdminCostVsPay({
		uniqueWorkerDays: 600,
		stripePlan: null,
		stripePriceId: null,
		catalog,
		manualPlan: 'standard',
		username: 'gifted-heavy',
	})
	expect(giftStandardNearAllotment.risk).toBe('free_near_allotment')
	expect(giftStandardNearAllotment.underwater).toBe(false)

	const maxOperator = toAdminCostVsPay({
		uniqueWorkerDays: 20_000,
		stripePlan: null,
		stripePriceId: null,
		catalog,
		manualPlan: 'max',
		username: 'kentcdodds',
	})
	expect(maxOperator.estimatedGrossUsd).toBe(40)
	expect(maxOperator.underwater).toBe(false)
	expect(maxOperator.risk).toBe('none')
	expect(
		isOperatorCostNoise({ username: 'kentcdodds', manualPlan: 'free' }),
	).toBe(true)
	expect(
		isOperatorCostNoise({ username: 'ops-admin', manualPlan: 'free' }),
	).toBe(false)
	expect(
		classifyAdminCostRisk({
			estimatedGrossUsd: 4,
			estimatedPaidUsdCents: 0,
			paidSource: 'none',
			stripePlan: null,
			manualPlan: 'free',
			username: 'kentcdodds',
		}),
	).toBe('none')
	expect(
		classifyAdminCostRisk({
			estimatedGrossUsd: 4,
			estimatedPaidUsdCents: 0,
			paidSource: 'none',
			stripePlan: null,
			manualPlan: 'free',
			username: 'ops-admin',
			isOperator: true,
		}),
	).toBe('none')

	const paidOperatorUnderwater = toAdminCostVsPay({
		uniqueWorkerDays: 7_000,
		stripePlan: 'standard',
		stripePriceId: 'price_standard',
		catalog,
		manualPlan: 'free',
		username: 'ops-admin',
		isOperator: true,
	})
	expect(paidOperatorUnderwater.risk).toBe('paid_underwater')
	expect(paidOperatorUnderwater.underwater).toBe(true)

	expect(
		classifyAdminCostRisk({
			estimatedGrossUsd: 14,
			estimatedPaidUsdCents: 1_200,
			paidSource: 'stripe_catalog',
			stripePlan: 'standard',
			manualPlan: 'free',
			username: 'kentcdodds',
		}),
	).toBe('none')
})

test('rankRiskCostConsumers ranks within buckets and drops pennies and operator noise', () => {
	const ranked = rankRiskCostConsumers(
		[
			toAdminCostVsPayConsumer({
				stableUserId: 'paid-small-deficit',
				username: 'paid-small-deficit',
				uniqueWorkerDays: 6_100,
				stripePlan: 'standard',
				stripePriceId: 'price_standard',
				catalog,
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'paid-big-deficit',
				username: 'paid-big-deficit',
				uniqueWorkerDays: 8_000,
				stripePlan: 'standard',
				stripePriceId: 'price_standard',
				catalog,
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'free-pennies',
				username: 'free-pennies',
				uniqueWorkerDays: 90,
				stripePlan: null,
				stripePriceId: null,
				catalog,
				manualPlan: 'free',
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'free-near',
				username: 'free-near',
				uniqueWorkerDays: 600,
				stripePlan: null,
				stripePriceId: null,
				catalog,
				manualPlan: 'free',
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'free-past',
				username: 'free-past',
				uniqueWorkerDays: 1_200,
				stripePlan: null,
				stripePriceId: null,
				catalog,
				manualPlan: 'free',
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'missing-price',
				username: 'maciek',
				uniqueWorkerDays: 481,
				stripePlan: 'standard',
				stripePriceId: 'price_unknown',
				catalog,
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'operator',
				username: 'kentcdodds',
				uniqueWorkerDays: 20_000,
				stripePlan: null,
				stripePriceId: null,
				catalog,
				manualPlan: 'max',
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'paid-admin-deficit',
				username: 'ops-admin',
				uniqueWorkerDays: 7_000,
				stripePlan: 'standard',
				stripePriceId: 'price_standard',
				catalog,
				isOperator: true,
			}),
			toAdminCostVsPayConsumer({
				stableUserId: 'unpaid-admin-heavy',
				username: 'ops-admin-free',
				uniqueWorkerDays: 1_200,
				stripePlan: null,
				stripePriceId: null,
				catalog,
				manualPlan: 'free',
				isOperator: true,
			}),
		],
		10,
	)
	expect(ranked.map((row) => row.stableUserId)).toEqual([
		'paid-big-deficit',
		'paid-admin-deficit',
		'paid-small-deficit',
		'free-past',
		'free-near',
		'missing-price',
	])
	expect(ranked.map((row) => row.risk)).toEqual([
		'paid_underwater',
		'paid_underwater',
		'paid_underwater',
		'free_near_allotment',
		'free_near_allotment',
		'missing_price_id',
	])
})
