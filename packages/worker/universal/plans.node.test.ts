import { expect, test } from 'vitest'
import {
	cloudflareComputeListUsd,
	computeMeteringPolicy,
	computeOverageRatesUsd,
	formatDurableObjectRowsRead,
	legacyPlanLimits,
	parseEntitlementLadder,
	planLimits,
	resolveEntitlementLadderAfterPaidAccessChange,
	resolvePlanLimit,
	resolvePlanLimits,
} from './plans.ts'

test('public Standard and Pro caps match the launch ladder', () => {
	expect(planLimits.free.maxExecuteCallsPerDay).toBe(100)
	expect(planLimits.free.maxScheduledJobs).toBe(5)
	expect(planLimits.free.minJobIntervalMs).toBe(15 * 60 * 1000)
	expect(planLimits.free.maxJobRunsPerDay).toBe(500)
	expect(planLimits.free.maxUniqueWorkerDaysPerMonth).toBe(50)
	expect(planLimits.free.maxDurableObjectRowsReadPerMonth).toBe(500_000_000)

	expect(planLimits.standard.maxScheduledJobs).toBe(15)
	expect(planLimits.standard.minJobIntervalMs).toBe(15 * 60 * 1000)
	expect(planLimits.standard.maxExecuteCallsPerDay).toBe(150)
	expect(planLimits.standard.maxJobRunsPerDay).toBe(1_500)
	expect(planLimits.standard.maxOutboundFetchesPerDay).toBe(5_000)
	expect(planLimits.standard.maxSavedPackages).toBe(50)
	expect(planLimits.standard.maxConcurrentWorkflows).toBe(10)
	expect(planLimits.standard.maxUniqueWorkerDaysPerMonth).toBe(350)
	expect(planLimits.standard.maxDurableObjectRowsReadPerMonth).toBe(
		5_000_000_000,
	)

	expect(planLimits.pro.maxScheduledJobs).toBe(75)
	expect(planLimits.pro.minJobIntervalMs).toBe(5 * 60 * 1000)
	expect(planLimits.pro.maxExecuteCallsPerDay).toBe(750)
	expect(planLimits.pro.maxJobRunsPerDay).toBe(8_000)
	expect(planLimits.pro.maxOutboundFetchesPerDay).toBe(25_000)
	expect(planLimits.pro.maxSavedPackages).toBe(200)
	expect(planLimits.pro.maxConcurrentWorkflows).toBe(50)
	expect(planLimits.pro.maxStorageBytes).toBe(5 * 1024 * 1024 * 1024)
	expect(planLimits.pro.maxUniqueWorkerDaysPerMonth).toBe(2_000)
	expect(planLimits.pro.maxDurableObjectRowsReadPerMonth).toBe(20_000_000_000)
})

test('legacy Standard and Pro keep the pre-cut ceilings', () => {
	expect(legacyPlanLimits.standard.maxScheduledJobs).toBe(50)
	expect(legacyPlanLimits.standard.minJobIntervalMs).toBe(0)
	expect(legacyPlanLimits.standard.maxExecuteCallsPerDay).toBe(500)
	expect(legacyPlanLimits.standard.maxJobRunsPerDay).toBe(10_000)
	expect(legacyPlanLimits.standard.maxOutboundFetchesPerDay).toBe(20_000)
	expect(legacyPlanLimits.standard.maxSavedPackages).toBe(100)
	expect(legacyPlanLimits.standard.maxConcurrentWorkflows).toBe(50)

	expect(legacyPlanLimits.pro.maxScheduledJobs).toBe(150)
	expect(legacyPlanLimits.pro.minJobIntervalMs).toBe(0)
	expect(legacyPlanLimits.pro.maxExecuteCallsPerDay).toBe(800)
	expect(legacyPlanLimits.pro.maxJobRunsPerDay).toBe(20_000)
	expect(legacyPlanLimits.pro.maxOutboundFetchesPerDay).toBe(40_000)
	expect(legacyPlanLimits.pro.maxConcurrentWorkflows).toBe(100)
	expect(legacyPlanLimits.standard.maxUniqueWorkerDaysPerMonth).toBe(
		planLimits.standard.maxUniqueWorkerDaysPerMonth,
	)
	expect(legacyPlanLimits.pro.maxUniqueWorkerDaysPerMonth).toBe(
		planLimits.pro.maxUniqueWorkerDaysPerMonth,
	)
})

test('compute overage rates are wired and execute has no overage', () => {
	expect(computeOverageRatesUsd.uniqueWorkerDay).toBe(0.0025)
	expect(computeOverageRatesUsd.durableObjectRowsReadPerMillion).toBe(0.0015)
	expect(computeOverageRatesUsd.uniqueWorkerDay).toBe(
		cloudflareComputeListUsd.uniqueWorkerDay + 0.0005,
	)
	expect(computeOverageRatesUsd.durableObjectRowsReadPerMillion).toBe(
		cloudflareComputeListUsd.durableObjectRowsReadPerMillion + 0.0005,
	)
	expect(computeMeteringPolicy).toEqual({
		uniqueWorkerDays: 'included_then_overage',
		durableObjectRowsRead: 'included_then_overage',
		executeCallsPerDay: 'hard_daily_cap',
		durableObjectDuration: 'unmetered',
		publicMonthlyMeters: 'charge_list_rates',
		legacyMonthlyMeters: 'no_cut_no_bill',
		overageRole: 'heavy_tail_safety_valve',
	})
	expect(Object.keys(computeOverageRatesUsd).sort()).toEqual([
		'durableObjectRowsReadPerMillion',
		'uniqueWorkerDay',
	])
	expect(formatDurableObjectRowsRead(500_000_000)).toBe('0.5B')
	expect(formatDurableObjectRowsRead(5_000_000_000)).toBe('5B')
	expect(formatDurableObjectRowsRead(20_000_000_000)).toBe('20B')
})

test('resolvePlanLimit uses public numbers unless the legacy ladder applies', () => {
	expect(resolvePlanLimit('standard', 'execute_calls_per_day')).toBe(150)
	expect(resolvePlanLimit('standard', 'execute_calls_per_day', 'public')).toBe(
		150,
	)
	expect(resolvePlanLimit('standard', 'execute_calls_per_day', 'legacy')).toBe(
		500,
	)
	expect(resolvePlanLimit('pro', 'scheduled_jobs', 'legacy')).toBe(150)
	expect(resolvePlanLimit('pro', 'scheduled_jobs', 'public')).toBe(75)
	expect(resolvePlanLimit('free', 'execute_calls_per_day', 'legacy')).toBe(100)
	expect(resolvePlanLimit('max', 'execute_calls_per_day', 'legacy')).toBe(
		25_000,
	)
	expect(resolvePlanLimits('standard', 'legacy').minJobIntervalMs).toBe(0)
	expect(resolvePlanLimits('pro', 'public').minJobIntervalMs).toBe(
		5 * 60 * 1000,
	)
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
