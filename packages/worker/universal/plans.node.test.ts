import { expect, test } from 'vitest'
import {
	formatDurableObjectRowsRead,
	parseEntitlementLadder,
	planLimits,
	proCreditsPlanLimits,
	resolveCreditWalletState,
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
	expect(
		resolveWeeklyPlanLimit('free', 'execute_calls_per_day'),
	).toBeGreaterThan(0)
	expect(
		resolveWeeklyPlanLimit('standard', 'execute_calls_per_day'),
	).toBeGreaterThan(0)
	expect(
		resolveWeeklyPlanLimit('pro', 'execute_calls_per_day'),
	).toBeGreaterThan(0)
	expect(
		resolveWeeklyPlanLimit('free', 'outbound_fetches_per_day'),
	).toBeGreaterThan(0)
	expect(
		resolveWeeklyPlanLimit('standard', 'outbound_fetches_per_day'),
	).toBeGreaterThan(0)
	expect(
		resolveWeeklyPlanLimit('pro', 'outbound_fetches_per_day'),
	).toBeGreaterThan(0)
	expect(resolveWeeklyPlanLimit('max', 'execute_calls_per_day')).toBeNull()
	expect(
		resolveWeeklyPlanLimit('standard', 'execute_calls_per_day', 'legacy'),
	).toBeNull()
	expect(
		resolveWeeklyPlanLimit('pro', 'outbound_fetches_per_day', 'legacy'),
	).toBeNull()
	expect(resolveWeeklyPlanLimit('free', 'job_runs_per_day')).toBeNull()
	expect(
		resolveWeeklyPlanLimit('free', 'automation_invocations_per_day'),
	).toBeNull()
})

test('public automation ceilings sit above job runs; legacy stays job-matched', () => {
	expect(
		resolvePlanLimit('free', 'automation_invocations_per_day'),
	).toBeGreaterThan(resolvePlanLimit('free', 'job_runs_per_day'))
	expect(
		resolvePlanLimit('standard', 'automation_invocations_per_day'),
	).toBeGreaterThan(resolvePlanLimit('standard', 'job_runs_per_day'))
	expect(
		resolvePlanLimit('pro', 'automation_invocations_per_day'),
	).toBeGreaterThan(resolvePlanLimit('pro', 'job_runs_per_day'))
	expect(
		resolvePlanLimit('max', 'automation_invocations_per_day'),
	).toBeGreaterThan(resolvePlanLimit('max', 'job_runs_per_day'))
	expect(
		resolvePlanLimit('standard', 'automation_invocations_per_day', 'legacy'),
	).toBe(resolvePlanLimit('standard', 'job_runs_per_day', 'legacy'))
	expect(
		resolvePlanLimit('pro', 'automation_invocations_per_day', 'legacy'),
	).toBe(resolvePlanLimit('pro', 'job_runs_per_day', 'legacy'))
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

test('credit wallet state: only an eligible Pro wallet counts; balance > 0 funds it', () => {
	expect(
		resolveCreditWalletState({
			plan: 'pro',
			creditsEligible: true,
			balanceMicroUsd: 1,
		}),
	).toBe('funded')
	for (const balanceMicroUsd of [0, -4_000, null, undefined, Number.NaN]) {
		expect(
			resolveCreditWalletState({
				plan: 'pro',
				creditsEligible: true,
				balanceMicroUsd,
			}),
		).toBe('empty')
	}
	// Retired Pro/Standard, Free, and a manual max never get a wallet.
	for (const plan of ['free', 'standard', 'max'] as const) {
		expect(
			resolveCreditWalletState({
				plan,
				creditsEligible: true,
				balanceMicroUsd: 10_000_000,
			}),
		).toBe('none')
	}
	expect(
		resolveCreditWalletState({
			plan: 'pro',
			creditsEligible: false,
			balanceMicroUsd: 10_000_000,
		}),
	).toBe('none')
})

test('purchasable Pro has Max stock always; funded wallet raises rate ceilings only', () => {
	const empty = resolvePlanLimits('pro', 'public', 'empty')
	expect(empty).toEqual(proCreditsPlanLimits)
	expect(resolvePlanLimit('pro', 'saved_packages', 'public', 'empty')).toBe(
		10_000,
	)
	expect(resolvePlanLimit('pro', 'secrets', 'public', 'empty')).toBe(10_000)
	expect(resolvePlanLimit('pro', 'scheduled_jobs', 'public', 'empty')).toBe(
		5_000,
	)
	expect(resolvePlanLimit('pro', 'repos', 'public', 'empty')).toBe(10_000)
	expect(resolvePlanLimit('pro', 'repo_sessions', 'public', 'empty')).toBe(
		20_000,
	)
	expect(resolvePlanLimit('pro', 'storage_bytes', 'public', 'empty')).toBe(
		100 * 1024 * 1024 * 1024,
	)
	expect(
		resolvePlanLimit('pro', 'concurrent_workflows', 'public', 'empty'),
	).toBe(200)
	expect(
		resolvePlanLimit('pro', 'execute_calls_per_day', 'public', 'empty'),
	).toBe(500)
	expect(empty.maxUniqueWorkerDaysPerMonth).toBe(350)
	expect(empty.maxDurableObjectRowsReadPerMonth).toBe(5_000_000_000)

	// Retired $49 Pro keeps its own table.
	expect(resolvePlanLimits('pro', 'public', 'none')).toEqual(planLimits.pro)

	const funded = resolvePlanLimits('pro', 'public', 'funded')
	// Funded keeps the same Max stock as empty; only rates rise.
	expect(funded.maxSavedPackages).toBe(10_000)
	expect(funded.maxSecrets).toBe(10_000)
	expect(funded.maxConcurrentWorkflows).toBe(200)
	expect(funded.maxOutboundFetchesPerDay).toBe(80_000)
	expect(funded.maxOutboundFetchesPerWeek).toBe(560_000)
	expect(funded.maxJobRunsPerDay).toBe(40_000)
	expect(funded.maxAutomationInvocationsPerDay).toBe(200_000)
	expect(
		resolvePlanLimit('pro', 'execute_calls_per_day', 'public', 'funded'),
	).toBe(25_000)
	expect(
		resolveWeeklyPlanLimit('pro', 'execute_calls_per_day', 'public', 'funded'),
	).toBe(60_000)
	expect(
		resolvePlanLimit('pro', 'email_sends_per_day', 'public', 'funded'),
	).toBe(200)
	expect(
		resolvePlanLimit('pro', 'email_sends_per_day', 'public', 'empty'),
	).toBe(200)
	expect(funded.minJobIntervalMs).toBe(15 * 60 * 1000)
	expect(funded.maxUniqueWorkerDaysPerMonth).toBe(350)
	expect(funded.maxDurableObjectRowsReadPerMonth).toBe(5_000_000_000)
	// Non-credits-eligible Pro and non-Pro tables are unchanged by wallet state.
	expect(resolvePlanLimits('free', 'public', 'funded')).toEqual(planLimits.free)
	expect(resolvePlanLimits('max', 'public', 'funded')).toEqual(planLimits.max)
})
