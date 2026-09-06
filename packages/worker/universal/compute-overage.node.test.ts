import { expect, test } from 'vitest'
import {
	computeMonthlyOverage,
	computeOverageBillingPolicy,
	computeOverageIncludePercent,
	previousUtcMonthKey,
	resolveComputeOverageDisposition,
	type ComputeOverageDisposition,
} from './compute-overage.ts'
import { computeOverageRatesUsd, planLimits } from './plans.ts'

test('public-ladder include math bills only the units above the allotment', () => {
	const free = computeMonthlyOverage({
		plan: 'free',
		ladder: 'public',
		uniqueWorkerDays: planLimits.free.maxUniqueWorkerDaysPerMonth + 12,
		durableObjectRowsRead:
			planLimits.free.maxDurableObjectRowsReadPerMonth + 2_000_000,
	})
	expect(free.billableUniqueWorkerDays).toBe(12)
	expect(free.billableDurableObjectRowsRead).toBe(2_000_000)
	expect(free.uniqueWorkerDayUsd).toBe(
		12 * computeOverageRatesUsd.uniqueWorkerDay,
	)
	expect(free.durableObjectRowsReadUsd).toBe(
		2 * computeOverageRatesUsd.durableObjectRowsReadPerMillion,
	)
	expect(free.uniqueWorkerDayCents).toBe(3)
	expect(free.durableObjectRowsReadCents).toBe(0)
	expect(free.totalCents).toBe(3)
	expect(free.legacyUnbilled).toBe(false)

	const standard = computeMonthlyOverage({
		plan: 'standard',
		ladder: 'public',
		uniqueWorkerDays: planLimits.standard.maxUniqueWorkerDaysPerMonth + 400,
		durableObjectRowsRead:
			planLimits.standard.maxDurableObjectRowsReadPerMonth + 10_000_000,
	})
	expect(standard.billableUniqueWorkerDays).toBe(400)
	expect(standard.uniqueWorkerDayCents).toBe(100)
	expect(standard.durableObjectRowsReadCents).toBe(2)
	expect(standard.totalCents).toBe(102)

	const atInclude = computeMonthlyOverage({
		plan: 'pro',
		ladder: 'public',
		uniqueWorkerDays: planLimits.pro.maxUniqueWorkerDaysPerMonth,
		durableObjectRowsRead: planLimits.pro.maxDurableObjectRowsReadPerMonth,
	})
	expect(atInclude.totalCents).toBe(0)
})

test('usage at or below the include, junk counts, and max stay at zero cents', () => {
	expect(
		computeMonthlyOverage({
			plan: 'free',
			ladder: 'public',
			uniqueWorkerDays: 49,
			durableObjectRowsRead: 100,
		}).totalCents,
	).toBe(0)
	expect(
		computeMonthlyOverage({
			plan: 'pro',
			ladder: 'public',
			uniqueWorkerDays: Number.NaN,
			durableObjectRowsRead: Number.POSITIVE_INFINITY,
		}),
	).toMatchObject({
		billableUniqueWorkerDays: 0,
		billableDurableObjectRowsRead: 0,
		totalCents: 0,
	})
	expect(
		computeMonthlyOverage({
			plan: 'max',
			ladder: 'public',
			uniqueWorkerDays: 25_000,
			durableObjectRowsRead: 200_000_000_000,
		}).totalCents,
	).toBe(0)
})

test('legacy Standard and Pro compute display amounts but stay unbilled', () => {
	const legacy = computeMonthlyOverage({
		plan: 'pro',
		ladder: 'legacy',
		uniqueWorkerDays: 50_000,
		durableObjectRowsRead: 40_000_000_000,
	})
	expect(legacy.includedUniqueWorkerDays).toBe(
		planLimits.pro.maxUniqueWorkerDaysPerMonth,
	)
	expect(legacy.billableUniqueWorkerDays).toBe(48_000)
	expect(legacy.uniqueWorkerDayCents).toBe(12_000)
	expect(legacy.legacyUnbilled).toBe(true)
	expect(
		resolveComputeOverageDisposition({
			plan: 'pro',
			ladder: 'legacy',
			overage: legacy,
			hasStripeCustomer: true,
			chargingEnabled: true,
			policy: { ...computeOverageBillingPolicy, audience: 'everyone' },
		}),
	).toBe('skip_legacy')
})

test('quarter-cent unique-worker-day rates round to integer Stripe cents', () => {
	const oneDay = computeMonthlyOverage({
		plan: 'free',
		ladder: 'public',
		uniqueWorkerDays: 51,
		durableObjectRowsRead: 0,
	})
	expect(oneDay.uniqueWorkerDayUsd).toBe(0.0025)
	expect(oneDay.uniqueWorkerDayCents).toBe(0)

	const twoDays = computeMonthlyOverage({
		plan: 'free',
		ladder: 'public',
		uniqueWorkerDays: 52,
		durableObjectRowsRead: 0,
	})
	expect(twoDays.uniqueWorkerDayCents).toBe(1)
})

test('public policy invoices paid customers, soft-blocks unpaid Free, and never bills legacy', () => {
	const freeOverage = computeMonthlyOverage({
		plan: 'free',
		ladder: 'public',
		uniqueWorkerDays: 60,
		durableObjectRowsRead: 0,
	})
	const paidOverage = computeMonthlyOverage({
		plan: 'standard',
		ladder: 'public',
		uniqueWorkerDays: 400,
		durableObjectRowsRead: 0,
	})

	expect(computeOverageBillingPolicy).toEqual({
		audience: 'public',
		chargeLegacy: false,
	})
	expect(computeOverageIncludePercent(40, 50)).toBe(0.8)
	expect(computeOverageIncludePercent(50, 50)).toBe(1)
	expect(computeOverageIncludePercent(0, 50)).toBe(0)

	const cases: Array<
		[
			string,
			Parameters<typeof resolveComputeOverageDisposition>[0],
			ComputeOverageDisposition,
		]
	> = [
		[
			'charging off is dry-run for paid-public with a customer',
			{
				plan: 'standard',
				ladder: 'public',
				overage: paidOverage,
				hasStripeCustomer: true,
				chargingEnabled: false,
			},
			'dry_run',
		],
		[
			'unpaid Free is a soft-block, never a Stripe charge',
			{
				plan: 'free',
				ladder: 'public',
				overage: freeOverage,
				hasStripeCustomer: false,
				chargingEnabled: true,
			},
			'soft_block',
		],
		[
			'Free with a leftover Stripe customer can invoice when charging is on',
			{
				plan: 'free',
				ladder: 'public',
				overage: freeOverage,
				hasStripeCustomer: true,
				chargingEnabled: true,
			},
			'invoice',
		],
		[
			'paid-public with a customer invoices when charging is on',
			{
				plan: 'standard',
				ladder: 'public',
				overage: paidOverage,
				hasStripeCustomer: true,
				chargingEnabled: true,
			},
			'invoice',
		],
		[
			'paid-public without a customer stays dry-run',
			{
				plan: 'pro',
				ladder: 'public',
				overage: paidOverage,
				hasStripeCustomer: false,
				chargingEnabled: true,
			},
			'dry_run',
		],
		[
			'zero cents is a skip, not a soft-block',
			{
				plan: 'free',
				ladder: 'public',
				overage: computeMonthlyOverage({
					plan: 'free',
					ladder: 'public',
					uniqueWorkerDays: 10,
					durableObjectRowsRead: 0,
				}),
				hasStripeCustomer: false,
				chargingEnabled: true,
			},
			'skip_zero',
		],
	]
	for (const [label, input, expected] of cases) {
		expect(resolveComputeOverageDisposition(input), label).toBe(expected)
	}
})

test('previousUtcMonthKey walks across year boundaries', () => {
	expect(previousUtcMonthKey(new Date('2026-01-01T00:00:00.000Z'))).toBe(
		'2025-12',
	)
	expect(previousUtcMonthKey(new Date('2026-09-06T12:00:00.000Z'))).toBe(
		'2026-08',
	)
})
