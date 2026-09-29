import { expect, test } from 'vitest'
import {
	accountCreditsPath,
	buildComputeOverageHowToReduce,
	computeMonthlyOverage,
	computeOverageIncludePercent,
	resolveComputeIncludeCreditsStatus,
	resolvePastIncludeStop,
} from './compute-overage.ts'
import { planLimits, proCreditsPlanLimits } from './plans.ts'

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
	for (const uniqueWorkerDays of [0, -5, Number.NaN, 350]) {
		const overage = computeMonthlyOverage({
			plan: 'pro',
			ladder: 'public',
			creditWallet: 'empty',
			uniqueWorkerDays,
			durableObjectRowsRead:
				proCreditsPlanLimits.maxDurableObjectRowsReadPerMonth,
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

test('past-include stop: only an empty purchasable-Pro wallet stops, and only past the include', () => {
	const emptyPro = (uniqueWorkerDays: number, durableObjectRowsRead: number) =>
		resolvePastIncludeStop({
			plan: 'pro',
			ladder: 'public',
			creditWallet: 'empty',
			uniqueWorkerDays,
			durableObjectRowsRead,
		})
	// Include is free: at or under 350 / 5B never stops, even at $0.
	expect(emptyPro(350, 5_000_000_000)).toBeNull()
	expect(emptyPro(351, 0)).toEqual({
		resource: 'unique_worker_days',
		limit: 350,
		current: 351,
	})
	expect(emptyPro(10, 5_000_000_001)).toEqual({
		resource: 'durable_object_rows_read',
		limit: 5_000_000_000,
		current: 5_000_000_001,
	})
	// Worker compute wins when both are past.
	expect(emptyPro(400, 6_000_000_000)?.resource).toBe('unique_worker_days')
	// Funded wallets pay past the include; wallet-less plans keep hard caps.
	for (const input of [
		{ plan: 'pro', creditWallet: 'funded' },
		{ plan: 'pro', creditWallet: 'none' },
		{ plan: 'standard', creditWallet: 'none' },
		{ plan: 'free', creditWallet: 'none' },
		{ plan: 'max', creditWallet: 'none' },
	] as const) {
		expect(
			resolvePastIncludeStop({
				...input,
				ladder: 'public',
				uniqueWorkerDays: 1_000_000,
				durableObjectRowsRead: 1_000_000_000_000,
			}),
		).toBeNull()
	}
})
