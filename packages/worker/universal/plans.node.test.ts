import { expect, test } from 'vitest'
import {
	formatDurableObjectRowsRead,
	parseEntitlementLadder,
	planLimits,
	proCreditsEmptyWalletPlanLimits,
	resolveCreditWalletState,
	resolveEntitlementLadderAfterPaidAccessChange,
	resolvePlanLimit,
	resolvePlanLimits,
	resolveWeeklyPlanLimit,
} from './plans.ts'

type LimitArgs = Parameters<typeof resolvePlanLimit>
type LadderInput = Parameters<
	typeof resolveEntitlementLadderAfterPaidAccessChange
>[0]

// [expected, ...resolvePlanLimit args]
function limitMismatches(cases: Array<[number, ...LimitArgs]>) {
	return cases.filter(([want, ...args]) => resolvePlanLimit(...args) !== want)
}

test('formatDurableObjectRowsRead uses billion-scale labels', () => {
	expect(
		[500_000_000, 5_000_000_000, 20_000_000_000].map(
			formatDurableObjectRowsRead,
		),
	).toEqual(['0.5B', '5B', '20B'])
})

test('resolvePlanLimit uses public numbers unless the legacy ladder applies', () => {
	expect(
		limitMismatches([
			[150, 'free', 'execute_calls_per_day'],
			[500, 'standard', 'execute_calls_per_day'],
			[500, 'standard', 'execute_calls_per_day', 'public'],
			[500, 'standard', 'execute_calls_per_day', 'legacy'],
			[1_500, 'pro', 'execute_calls_per_day'],
			[50_000, 'pro', 'outbound_fetches_per_day'],
			[150, 'pro', 'scheduled_jobs', 'legacy'],
			[75, 'pro', 'scheduled_jobs', 'public'],
			[150, 'free', 'execute_calls_per_day', 'legacy'],
			[25_000, 'max', 'execute_calls_per_day', 'legacy'],
		]),
	).toEqual([])
	expect(resolvePlanLimits('standard', 'legacy').minJobIntervalMs).toBe(0)
	expect(resolvePlanLimits('pro', 'public').minJobIntervalMs).toBe(
		5 * 60 * 1000,
	)
})

test('public Free/Standard/Pro have weekly execute and outbound windows; max and legacy do not', () => {
	for (const plan of ['free', 'standard', 'pro'] as const) {
		for (const resource of [
			'execute_calls_per_day',
			'outbound_fetches_per_day',
		] as const) {
			expect(resolveWeeklyPlanLimit(plan, resource)).toBeGreaterThan(0)
		}
	}
	expect([
		resolveWeeklyPlanLimit('max', 'execute_calls_per_day'),
		resolveWeeklyPlanLimit('standard', 'execute_calls_per_day', 'legacy'),
		resolveWeeklyPlanLimit('pro', 'outbound_fetches_per_day', 'legacy'),
		resolveWeeklyPlanLimit('free', 'job_runs_per_day'),
		resolveWeeklyPlanLimit('free', 'automation_invocations_per_day'),
	]).toEqual([null, null, null, null, null])
})

test('public automation ceilings sit above job runs; legacy stays job-matched', () => {
	for (const plan of ['free', 'standard', 'pro', 'max'] as const) {
		expect(
			resolvePlanLimit(plan, 'automation_invocations_per_day'),
		).toBeGreaterThan(resolvePlanLimit(plan, 'job_runs_per_day'))
	}
	for (const plan of ['standard', 'pro'] as const) {
		expect(
			resolvePlanLimit(plan, 'automation_invocations_per_day', 'legacy'),
		).toBe(resolvePlanLimit(plan, 'job_runs_per_day', 'legacy'))
	}
})

test('parseEntitlementLadder treats blank as public and rejects unknown names', () => {
	expect([null, undefined, '', 'legacy'].map(parseEntitlementLadder)).toEqual([
		'public',
		'public',
		'public',
		'legacy',
	])
	expect(() => parseEntitlementLadder('v1')).toThrow(
		/not a registered ladder name/,
	)
})

test('legacy ladder survives continuous paid access and same-plan renews; cancel, plan, or price change drops it', () => {
	const ladder = (
		currentLadder: LadderInput['currentLadder'],
		manualPlan: LadderInput['manualPlan'],
		previousStripePlan: LadderInput['previousStripePlan'],
		nextStripePlan: LadderInput['nextStripePlan'],
		prices?: [string | null, string | null],
	): LadderInput => ({
		currentLadder,
		manualPlan,
		previousStripePlan,
		nextStripePlan,
		...(prices && {
			previousStripePriceId: prices[0],
			nextStripePriceId: prices[1],
		}),
	})
	const cases: Array<[LadderInput, 'legacy' | 'public']> = [
		[ladder('legacy', 'free', 'standard', 'standard'), 'legacy'],
		[ladder('legacy', 'free', 'pro', 'pro'), 'legacy'],
		[ladder('legacy', 'pro', null, null), 'legacy'],
		[ladder('legacy', 'free', 'standard', null), 'public'],
		[ladder('public', 'free', null, 'pro'), 'public'],
		[ladder('public', 'pro', null, null), 'public'],
		// Same-plan renew keeps legacy, including the first price observation.
		[
			ladder('legacy', 'free', 'pro', 'pro', ['price_pro', 'price_pro']),
			'legacy',
		],
		[ladder('legacy', 'free', 'pro', 'pro', [null, 'price_pro']), 'legacy'],
		// Plan or price change drops legacy; resubscribe stays public.
		[
			ladder('legacy', 'free', 'standard', 'pro', [
				'price_standard',
				'price_pro',
			]),
			'public',
		],
		[
			ladder('legacy', 'free', 'pro', 'pro', [
				'price_pro_month',
				'price_pro_year',
			]),
			'public',
		],
		[
			ladder('legacy', 'free', 'pro', 'pro', ['price_pro_29', 'price_pro_49']),
			'public',
		],
		[ladder('public', 'free', null, 'pro', [null, 'price_pro']), 'public'],
	]
	expect(
		cases.filter(
			([input, want]) =>
				resolveEntitlementLadderAfterPaidAccessChange(input) !== want,
		),
	).toEqual([])
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

test('purchasable Pro has Max stock always; empty wallet uses Free rates; funded raises ceilings', () => {
	const empty = resolvePlanLimits('pro', 'public', 'empty')
	expect(empty).toEqual(proCreditsEmptyWalletPlanLimits)
	expect(
		limitMismatches([
			[10_000, 'pro', 'saved_packages', 'public', 'empty'],
			[10_000, 'pro', 'secrets', 'public', 'empty'],
			[5_000, 'pro', 'scheduled_jobs', 'public', 'empty'],
			[10_000, 'pro', 'repos', 'public', 'empty'],
			[20_000, 'pro', 'repo_sessions', 'public', 'empty'],
			[100 * 1024 * 1024 * 1024, 'pro', 'storage_bytes', 'public', 'empty'],
			[200, 'pro', 'concurrent_workflows', 'public', 'empty'],
			[150, 'pro', 'execute_calls_per_day', 'public', 'empty'],
			[25_000, 'pro', 'execute_calls_per_day', 'public', 'funded'],
			[200, 'pro', 'email_sends_per_day', 'public', 'funded'],
			[10, 'pro', 'email_sends_per_day', 'public', 'empty'],
		]),
	).toEqual([])
	expect(empty.maxUniqueWorkerDaysPerMonth).toBe(
		proCreditsEmptyWalletPlanLimits.maxUniqueWorkerDaysPerMonth,
	)
	expect(empty.maxDurableObjectRowsReadPerMonth).toBe(
		proCreditsEmptyWalletPlanLimits.maxDurableObjectRowsReadPerMonth,
	)
	expect(empty.maxUniqueWorkerDaysPerMonth).toBe(350)
	expect(empty.maxDurableObjectRowsReadPerMonth).toBe(5_000_000_000)

	// Retired $49 Pro keeps its own table.
	expect(resolvePlanLimits('pro', 'public', 'none')).toEqual(planLimits.pro)

	// Funded keeps the same Max stock as empty; only rates rise.
	expect(resolvePlanLimits('pro', 'public', 'funded')).toMatchObject({
		maxSavedPackages: 10_000,
		maxSecrets: 10_000,
		maxConcurrentWorkflows: 200,
		maxOutboundFetchesPerDay: 80_000,
		maxOutboundFetchesPerWeek: 560_000,
		maxJobRunsPerDay: 40_000,
		maxAutomationInvocationsPerDay: 200_000,
		minJobIntervalMs: 15 * 60 * 1000,
		maxUniqueWorkerDaysPerMonth: 350,
		maxDurableObjectRowsReadPerMonth: 5_000_000_000,
	})
	expect(
		resolveWeeklyPlanLimit('pro', 'execute_calls_per_day', 'public', 'funded'),
	).toBe(60_000)
	// Non-credits-eligible Pro and non-Pro tables are unchanged by wallet state.
	expect(resolvePlanLimits('free', 'public', 'funded')).toEqual(planLimits.free)
	expect(resolvePlanLimits('max', 'public', 'funded')).toEqual(planLimits.max)
})
