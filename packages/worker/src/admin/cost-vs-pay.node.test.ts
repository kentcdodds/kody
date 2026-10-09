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
	STRIPE_PRO_PRICE_ID: 'price_pro',
	STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
})

const standardPriceId = 'price_1U3sg6LAQpAnsYszGeL2nc8O'
const paidStandard = {
	stripePlan: 'standard',
	stripePriceId: standardPriceId,
} as const

test('estimatePaidListMrrUsdCents uses catalog list MRR and treats overlays as $0', () => {
	expect(
		estimatePaidListMrrUsdCents({
			stripePlan: 'standard',
			stripePriceId: standardPriceId,
			catalog,
		}),
	).toEqual({ cents: 1_200, source: 'stripe_catalog' })
	expect(
		estimatePaidListMrrUsdCents({
			stripePlan: 'pro',
			stripePriceId: 'price_1UChg2LAQpAnsYszKAFCR778',
			catalog,
		}),
	).toEqual({ cents: 4_000, source: 'stripe_catalog' })
	expect(
		estimatePaidListMrrUsdCents({
			stripePlan: null,
			stripePriceId: standardPriceId,
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

function costVsPay(
	username: string,
	uniqueWorkerDays: number,
	overrides: Partial<Parameters<typeof toAdminCostVsPay>[0]> = {},
) {
	return toAdminCostVsPay({
		uniqueWorkerDays,
		stripePlan: null,
		stripePriceId: null,
		catalog,
		manualPlan: 'free',
		username,
		...overrides,
	})
}

test('toAdminCostVsPay buckets real risk instead of every unpaid penny', () => {
	const cases: Array<
		[
			ReturnType<typeof toAdminCostVsPay>,
			Partial<ReturnType<typeof toAdminCostVsPay>>,
		]
	> = [
		[
			costVsPay('cara', 90),
			{
				estimatedGrossUsd: 0.18,
				estimatedPaidUsdCents: 0,
				underwater: false,
				risk: 'none',
				paidSource: 'none',
			},
		],
		[
			costVsPay('climber', 500),
			{ estimatedGrossUsd: 1, underwater: false, risk: 'free_near_allotment' },
		],
		[
			costVsPay('heavy', 1_500),
			{ estimatedGrossUsd: 3, underwater: false, risk: 'free_near_allotment' },
		],
		[
			costVsPay('paid-light', 90, paidStandard),
			{
				estimatedGrossUsd: 0.18,
				estimatedPaidUsdCents: 1_200,
				underwater: false,
				risk: 'none',
				paidSource: 'stripe_catalog',
			},
		],
		[
			costVsPay('paid-heavy', 7_000, paidStandard),
			{
				estimatedGrossUsd: 14,
				estimatedPaidUsdCents: 1_200,
				underwater: true,
				risk: 'paid_underwater',
			},
		],
		[
			costVsPay('maciek', 481, { stripePlan: 'standard' }),
			{
				estimatedGrossUsd: 0.962,
				estimatedPaidUsdCents: 0,
				underwater: false,
				risk: 'missing_price_id',
				paidSource: 'none',
			},
		],
		[
			costVsPay('gifted', 481, { manualPlan: 'standard' }),
			{ risk: 'none', underwater: false },
		],
		[
			costVsPay('gifted-heavy', 600, { manualPlan: 'standard' }),
			{ risk: 'free_near_allotment', underwater: false },
		],
		[
			costVsPay('kentcdodds', 20_000, { manualPlan: 'max' }),
			{ estimatedGrossUsd: 40, underwater: false, risk: 'none' },
		],
		[
			costVsPay('ops-admin', 7_000, { ...paidStandard, isOperator: true }),
			{ risk: 'paid_underwater', underwater: true },
		],
	]
	for (const [actual, expected] of cases) {
		expect(actual).toMatchObject(expected)
	}

	expect(
		isOperatorCostNoise({ username: 'kentcdodds', manualPlan: 'free' }),
	).toBe(true)
	expect(
		isOperatorCostNoise({ username: 'ops-admin', manualPlan: 'free' }),
	).toBe(false)
	const unpaidRisk = {
		estimatedGrossUsd: 4,
		estimatedPaidUsdCents: 0,
		paidSource: 'none',
		stripePlan: null,
		manualPlan: 'free',
	} as const
	expect(classifyAdminCostRisk({ ...unpaidRisk, username: 'kentcdodds' })).toBe(
		'none',
	)
	expect(
		classifyAdminCostRisk({
			...unpaidRisk,
			username: 'ops-admin',
			isOperator: true,
		}),
	).toBe('none')
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
	const consumer = (
		stableUserId: string,
		uniqueWorkerDays: number,
		overrides: Partial<Parameters<typeof toAdminCostVsPayConsumer>[0]> = {},
	) =>
		toAdminCostVsPayConsumer({
			stableUserId,
			username: stableUserId,
			uniqueWorkerDays,
			stripePlan: null,
			stripePriceId: null,
			catalog,
			...overrides,
		})
	const free = { manualPlan: 'free' } as const
	const ranked = rankRiskCostConsumers(
		[
			consumer('paid-small-deficit', 6_100, paidStandard),
			consumer('paid-big-deficit', 8_000, paidStandard),
			consumer('free-pennies', 90, free),
			consumer('free-near', 600, free),
			consumer('free-past', 1_200, free),
			consumer('missing-price', 481, {
				username: 'maciek',
				stripePlan: 'standard',
				stripePriceId: 'price_unknown',
			}),
			consumer('operator', 20_000, {
				username: 'kentcdodds',
				manualPlan: 'max',
			}),
			consumer('paid-admin-deficit', 7_000, {
				...paidStandard,
				username: 'ops-admin',
				isOperator: true,
			}),
			consumer('unpaid-admin-heavy', 1_200, {
				...free,
				username: 'ops-admin-free',
				isOperator: true,
			}),
		],
		10,
	)
	expect(ranked.map((row) => [row.stableUserId, row.risk])).toEqual([
		['paid-big-deficit', 'paid_underwater'],
		['paid-admin-deficit', 'paid_underwater'],
		['paid-small-deficit', 'paid_underwater'],
		['free-past', 'free_near_allotment'],
		['free-near', 'free_near_allotment'],
		['missing-price', 'missing_price_id'],
	])
})
