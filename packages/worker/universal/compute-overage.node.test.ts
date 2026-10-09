import { expect, test } from 'vitest'
import {
	accountCreditsPath,
	buildComputeOverageHowToReduce,
	computeMonthlyOverage,
	computeOverageIncludePercent,
	resolveComputeIncludeCreditsStatus,
	resolvePastIncludeStop,
} from './compute-overage.ts'
import { planLimits } from './plans.ts'

test('purchasable Pro uses the retired Standard includes and prices only units above them', () => {
	const pro = computeMonthlyOverage({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'funded',
		uniqueWorkerDays: 350 + 400,
		durableObjectRowsRead: 5_000_000_000 + 10_000_000,
	})
	expect(pro.includedUniqueWorkerDays).toBe(350)
	expect(pro.includedDurableObjectRowsRead).toBe(5_000_000_000)
	expect(pro.billableUniqueWorkerDays).toBe(400)
	expect(pro.billableDurableObjectRowsRead).toBe(10_000_000)
	// 400 × $0.004 + 10 × $0.002 = $1.62
	expect(pro.creditsCostMicroUsd).toBe(1_620_000)

	// Retired $49 Pro keeps its larger include (no wallet).
	const retiredPro = computeMonthlyOverage({
		plan: 'pro',
		ladder: 'public',
		creditWallet: 'none',
		uniqueWorkerDays: 750,
		durableObjectRowsRead: 0,
	})
	expect(retiredPro.includedUniqueWorkerDays).toBe(
		planLimits.pro.maxUniqueWorkerDaysPerMonth,
	)
	expect(retiredPro.billableUniqueWorkerDays).toBe(0)
})

test('usage at or below the include and junk counts cost nothing', () => {
	for (const uniqueWorkerDays of [0, -5, Number.NaN, 50]) {
		const overage = computeMonthlyOverage({
			plan: 'pro',
			ladder: 'public',
			creditWallet: 'empty',
			uniqueWorkerDays,
			durableObjectRowsRead: planLimits.free.maxDurableObjectRowsReadPerMonth,
		})
		expect(overage.billableUniqueWorkerDays).toBe(0)
		expect(overage.creditsCostMicroUsd).toBe(0)
	}
	expect(computeOverageIncludePercent(175, 350)).toBe(0.5)
	expect(computeOverageIncludePercent(5, 0)).toBe(1)
	expect(computeOverageIncludePercent(0, 0)).toBe(0)
})

test('credits status separates debiting, add credits, switch to Pro, and operator plans', () => {
	type Input = Parameters<typeof resolveComputeIncludeCreditsStatus>[0]
	const cases: Array<[Input['plan'], Input['creditWallet'], boolean, string]> =
		[
			['pro', 'funded', false, 'within_include'],
			['pro', 'funded', true, 'debiting_credits'],
			['pro', 'empty', true, 'add_credits'],
			['free', 'none', true, 'switch_to_pro'],
			['standard', 'none', true, 'switch_to_pro'],
			['pro', 'none', true, 'switch_to_pro'],
			['max', 'none', true, 'not_charged'],
		]
	expect(
		cases.filter(
			([plan, creditWallet, pastInclude, want]) =>
				resolveComputeIncludeCreditsStatus({
					plan,
					creditWallet,
					pastInclude,
				}) !== want,
		),
	).toEqual([])
})

test('howToReduce points wallet and retired accounts at /account/usage#credits; Free stays informational', () => {
	const empty = buildComputeOverageHowToReduce(
		'unique_worker_days',
		'pro',
		'empty',
	)
	expect(empty).toContain(`Add credits at ${accountCreditsPath}`)
	expect(empty).toContain('rate and compute limits match Free')
	expect(empty).toContain('$0.004 per worker-compute day')
	expect(
		buildComputeOverageHowToReduce('durable_object_rows_read', 'pro', 'funded'),
	).toContain('charged from your credits at $0.002 per million rows read')
	const free = buildComputeOverageHowToReduce(
		'unique_worker_days',
		'free',
		'none',
	)
	expect(free).toContain('informational')
	expect(free).not.toContain(accountCreditsPath)
	expect(
		buildComputeOverageHowToReduce('unique_worker_days', 'standard', 'none'),
	).toContain('not charged on your plan')
	expect(
		buildComputeOverageHowToReduce('unique_worker_days', 'max', 'none'),
	).not.toContain(accountCreditsPath)
})

test('resolvePastIncludeStop is a no-op after ADR 0064 free-tier fallback', () => {
	for (const input of [
		{
			plan: 'pro' as const,
			creditWallet: 'empty' as const,
			uniqueWorkerDays: 351,
			durableObjectRowsRead: 5_000_000_001,
		},
		{
			plan: 'pro' as const,
			creditWallet: 'funded' as const,
			uniqueWorkerDays: 1_000_000,
			durableObjectRowsRead: 1_000_000_000_000,
		},
		{
			plan: 'free' as const,
			creditWallet: 'none' as const,
			uniqueWorkerDays: 1_000_000,
			durableObjectRowsRead: 1_000_000_000_000,
		},
	]) {
		expect(
			resolvePastIncludeStop({
				...input,
				ladder: 'public',
			}),
		).toBeNull()
	}
})
