import { expect, test } from 'vitest'
import {
	formatDurableObjectRowsRead,
	parseEntitlementLadder,
	resolveEntitlementLadderAfterPaidAccessChange,
	resolvePlanLimit,
	resolvePlanLimits,
	resolveWeeklyPlanLimit,
} from './plans.ts'

test('formatDurableObjectRowsRead uses billion-scale labels', () => {
	expect(formatDurableObjectRowsRead(500_000_000)).toBe('0.5B')
	expect(formatDurableObjectRowsRead(5_000_000_000)).toBe('5B')
	expect(formatDurableObjectRowsRead(20_000_000_000)).toBe('20B')
})

test('resolvePlanLimit uses public numbers unless the legacy ladder applies', () => {
	expect(resolvePlanLimit('free', 'execute_calls_per_day')).toBe(150)
	expect(resolvePlanLimit('standard', 'execute_calls_per_day')).toBe(500)
	expect(resolvePlanLimit('standard', 'execute_calls_per_day', 'public')).toBe(
		500,
	)
	expect(resolvePlanLimit('standard', 'execute_calls_per_day', 'legacy')).toBe(
		500,
	)
	expect(resolvePlanLimit('pro', 'execute_calls_per_day')).toBe(1_500)
	expect(resolvePlanLimit('pro', 'outbound_fetches_per_day')).toBe(50_000)
	expect(resolvePlanLimit('pro', 'scheduled_jobs', 'legacy')).toBe(150)
	expect(resolvePlanLimit('pro', 'scheduled_jobs', 'public')).toBe(75)
	expect(resolvePlanLimit('free', 'execute_calls_per_day', 'legacy')).toBe(150)
	expect(resolvePlanLimit('max', 'execute_calls_per_day', 'legacy')).toBe(
		25_000,
	)
	expect(resolvePlanLimits('standard', 'legacy').minJobIntervalMs).toBe(0)
	expect(resolvePlanLimits('pro', 'public').minJobIntervalMs).toBe(
		5 * 60 * 1000,
	)
})

test('public Free/Standard/Pro have weekly execute and outbound windows; max and legacy do not', () => {
	expect(resolveWeeklyPlanLimit('free', 'execute_calls_per_day')).toBe(400)
	expect(resolveWeeklyPlanLimit('standard', 'execute_calls_per_day')).toBe(
		1_200,
	)
	expect(resolveWeeklyPlanLimit('pro', 'execute_calls_per_day')).toBe(4_000)
	expect(resolveWeeklyPlanLimit('free', 'outbound_fetches_per_day')).toBe(2_500)
	expect(resolveWeeklyPlanLimit('standard', 'outbound_fetches_per_day')).toBe(
		40_000,
	)
	expect(resolveWeeklyPlanLimit('pro', 'outbound_fetches_per_day')).toBe(
		120_000,
	)
	expect(resolveWeeklyPlanLimit('max', 'execute_calls_per_day')).toBeNull()
	expect(
		resolveWeeklyPlanLimit('standard', 'execute_calls_per_day', 'legacy'),
	).toBeNull()
	expect(
		resolveWeeklyPlanLimit('pro', 'outbound_fetches_per_day', 'legacy'),
	).toBeNull()
	expect(resolveWeeklyPlanLimit('free', 'job_runs_per_day')).toBeNull()
})

test('parseEntitlementLadder treats blank as public and rejects unknown names', () => {
	expect(parseEntitlementLadder(null)).toBe('public')
	expect(parseEntitlementLadder(undefined)).toBe('public')
	expect(parseEntitlementLadder('')).toBe('public')
	expect(parseEntitlementLadder('legacy')).toBe('legacy')
	expect(() => parseEntitlementLadder('v1')).toThrow(
		/not a registered ladder name/,
	)
})

test('legacy ladder survives continuous paid access and drops after cancel', () => {
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			previousStripePlan: 'standard',
			nextStripePlan: 'standard',
		}),
	).toBe('legacy')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			previousStripePlan: 'pro',
			nextStripePlan: 'pro',
		}),
	).toBe('legacy')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'pro',
			previousStripePlan: null,
			nextStripePlan: null,
		}),
	).toBe('legacy')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			previousStripePlan: 'standard',
			nextStripePlan: null,
		}),
	).toBe('public')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'public',
			manualPlan: 'free',
			previousStripePlan: null,
			nextStripePlan: 'pro',
		}),
	).toBe('public')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'public',
			manualPlan: 'pro',
			previousStripePlan: null,
			nextStripePlan: null,
		}),
	).toBe('public')
})

test('same-plan renew keeps legacy including the first price observation', () => {
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			previousStripePlan: 'pro',
			nextStripePlan: 'pro',
			previousStripePriceId: 'price_pro',
			nextStripePriceId: 'price_pro',
		}),
	).toBe('legacy')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			previousStripePlan: 'pro',
			nextStripePlan: 'pro',
			previousStripePriceId: null,
			nextStripePriceId: 'price_pro',
		}),
	).toBe('legacy')
})

test('plan or price change drops legacy; resubscribe stays public', () => {
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			previousStripePlan: 'standard',
			nextStripePlan: 'pro',
			previousStripePriceId: 'price_standard',
			nextStripePriceId: 'price_pro',
		}),
	).toBe('public')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			previousStripePlan: 'pro',
			nextStripePlan: 'pro',
			previousStripePriceId: 'price_pro_month',
			nextStripePriceId: 'price_pro_year',
		}),
	).toBe('public')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			previousStripePlan: 'pro',
			nextStripePlan: 'pro',
			previousStripePriceId: 'price_pro_29',
			nextStripePriceId: 'price_pro_49',
		}),
	).toBe('public')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'public',
			manualPlan: 'free',
			previousStripePlan: null,
			nextStripePlan: 'pro',
			previousStripePriceId: null,
			nextStripePriceId: 'price_pro',
		}),
	).toBe('public')
})
