import { expect, test } from 'vitest'
import { planLimits, proCreditsPlanLimits, resolvePlanLimits } from './plans.ts'
import { pricingLimitColumns } from './pricing-limits.ts'

test('pricing columns show the limits enforced for each purchasable plan', () => {
	const byId = Object.fromEntries(
		pricingLimitColumns.map((column) => [column.id, column.limits]),
	)
	expect(byId).toEqual({
		free: resolvePlanLimits('free'),
		pro: proCreditsPlanLimits,
		'pro-credits': resolvePlanLimits('pro', 'public', 'funded'),
	})
	expect(byId.free).toBe(planLimits.free)
	expect(byId.pro).not.toEqual(planLimits.pro)
	expect(byId['pro-credits']!.maxExecuteUniqueWorkersPerDay).toBeGreaterThan(
		proCreditsPlanLimits.maxExecuteUniqueWorkersPerDay,
	)
	expect(
		pricingLimitColumns.map((column) => [
			column.id,
			column.limits.maxOutboundFetchesPerDay,
			column.limits.maxOutboundFetchesPerWeek,
		]),
	).toEqual([
		['free', 1_000, 2_500],
		['pro', 15_000, 40_000],
		['pro-credits', 750_000, 2_000_000],
	])
	expect(
		pricingLimitColumns
			.filter((column) => column.chargesPastInclude)
			.map((column) => column.id),
	).toEqual(['pro-credits'])
})
