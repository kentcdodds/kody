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
	expect(byId['pro-credits']!.maxExecuteCallsPerDay).toBeGreaterThan(
		proCreditsPlanLimits.maxExecuteCallsPerDay,
	)
})
