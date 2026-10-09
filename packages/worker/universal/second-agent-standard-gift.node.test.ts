import { expect, test } from 'vitest'
import {
	describeSecondAgentStandardGift,
	isSecondAgentStandardGiftActive,
	resolveEffectivePlanWithSecondAgentGift,
	resolvePlanOverlay,
	resolveSecondAgentStandardGiftWrite,
} from './second-agent-standard-gift.ts'

const now = new Date('2026-09-07T12:00:00.000Z')
const inTwoWeeks = '2026-09-21T12:00:00.000Z'
const yesterday = '2026-09-06T12:00:00.000Z'
const granted = now.toISOString()

type PlanArgs = Parameters<typeof resolvePlanOverlay>

test('gift overlay raises free to the purchasable Pro once, never double-applies, and no-ops paid tiers', () => {
	expect(
		[inTwoWeeks, yesterday, null].map((expiresAt) =>
			isSecondAgentStandardGiftActive(expiresAt, now),
		),
	).toEqual([true, false, false])

	// Retired Standard keeps its own plan (and table) under an overlay.
	const overlays: Array<[PlanArgs, ReturnType<typeof resolvePlanOverlay>]> = [
		[['free', null, inTwoWeeks, now], { plan: 'pro', isProOverlay: true }],
		[
			['free', 'standard', inTwoWeeks, now],
			{ plan: 'standard', isProOverlay: false },
		],
		[['free', 'pro', inTwoWeeks, now], { plan: 'pro', isProOverlay: false }],
	]
	expect(overlays.map(([args]) => [args, resolvePlanOverlay(...args)])).toEqual(
		overlays,
	)

	const effective: Array<[PlanArgs, string]> = [
		[['free', null, inTwoWeeks, now], 'pro'],
		[['free', null, yesterday, now], 'free'],
		[['free', 'standard', inTwoWeeks, now], 'standard'],
		[['free', 'pro', inTwoWeeks, now], 'pro'],
		[['max', null, inTwoWeeks, now], 'max'],
		[['pro', 'standard', inTwoWeeks, now], 'pro'],
	]
	expect(
		effective.map(([args]) => [
			args,
			resolveEffectivePlanWithSecondAgentGift(...args),
		]),
	).toEqual(effective)

	expect(
		resolveSecondAgentStandardGiftWrite({
			manualPlan: 'free',
			stripePlan: null,
			now,
		}).expiresAt,
	).toBe(inTwoWeeks)

	// Already-paid Standard/Pro (and manual standard/pro/max): do not extend
	// Stripe. There is no existing trial-period helper.
	const alreadyPaid = [
		{ manualPlan: 'free', stripePlan: 'standard' },
		{ manualPlan: 'free', stripePlan: 'pro' },
		{ manualPlan: 'standard', stripePlan: null },
		{ manualPlan: 'max', stripePlan: null },
	] as const
	expect(
		alreadyPaid.map((plans) =>
			resolveSecondAgentStandardGiftWrite({ ...plans, now }),
		),
	).toEqual(alreadyPaid.map(() => ({ expiresAt: null })))

	const descriptions = [
		[null, null, { received: false, active: false, status: 'none' }],
		[granted, inTwoWeeks, { received: true, active: true, status: 'active' }],
		[granted, yesterday, { received: true, active: false, status: 'expired' }],
		[granted, null, { received: true, active: false, status: 'already_paid' }],
	] as const
	expect(
		descriptions.map(([grantedAt, expiresAt]) =>
			describeSecondAgentStandardGift({ grantedAt, expiresAt, now }),
		),
	).toEqual(
		descriptions.map(([grantedAt, expiresAt, state]) => ({
			...state,
			expiresAt,
			grantedAt,
		})),
	)
})
