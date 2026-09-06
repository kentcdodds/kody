import { expect, test } from 'vitest'
import {
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
	expect(planLimits.free.maxUniqueWorkerDaysPerMonth).toBe(75)

	expect(planLimits.standard.maxScheduledJobs).toBe(15)
	expect(planLimits.standard.minJobIntervalMs).toBe(15 * 60 * 1000)
	expect(planLimits.standard.maxExecuteCallsPerDay).toBe(150)
	expect(planLimits.standard.maxJobRunsPerDay).toBe(1_500)
	expect(planLimits.standard.maxOutboundFetchesPerDay).toBe(5_000)
	expect(planLimits.standard.maxSavedPackages).toBe(50)
	expect(planLimits.standard.maxConcurrentWorkflows).toBe(10)
	expect(planLimits.standard.maxUniqueWorkerDaysPerMonth).toBe(400)

	expect(planLimits.pro.maxScheduledJobs).toBe(75)
	expect(planLimits.pro.minJobIntervalMs).toBe(5 * 60 * 1000)
	expect(planLimits.pro.maxExecuteCallsPerDay).toBe(750)
	expect(planLimits.pro.maxJobRunsPerDay).toBe(8_000)
	expect(planLimits.pro.maxOutboundFetchesPerDay).toBe(25_000)
	expect(planLimits.pro.maxSavedPackages).toBe(200)
	expect(planLimits.pro.maxConcurrentWorkflows).toBe(50)
	expect(planLimits.pro.maxStorageBytes).toBe(5 * 1024 * 1024 * 1024)
	expect(planLimits.pro.maxUniqueWorkerDaysPerMonth).toBe(2_500)
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
			stripePlan: 'standard',
		}),
	).toBe('legacy')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			stripePlan: 'pro',
		}),
	).toBe('legacy')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'pro',
			stripePlan: null,
		}),
	).toBe('legacy')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'legacy',
			manualPlan: 'free',
			stripePlan: null,
		}),
	).toBe('public')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'public',
			manualPlan: 'free',
			stripePlan: 'pro',
		}),
	).toBe('public')
	expect(
		resolveEntitlementLadderAfterPaidAccessChange({
			currentLadder: 'public',
			manualPlan: 'pro',
			stripePlan: null,
		}),
	).toBe('public')
})
