import { expect, test } from 'vitest'
import {
	describeSecondAgentStandardGift,
	isSecondAgentStandardGiftActive,
	resolveEffectivePlanWithSecondAgentGift,
	resolveSecondAgentStandardGiftWrite,
} from './second-agent-standard-gift.ts'

const now = new Date('2026-09-07T12:00:00.000Z')
const inTwoWeeks = '2026-09-21T12:00:00.000Z'
const yesterday = '2026-09-06T12:00:00.000Z'

test('gift overlay raises free to Standard once, never double-applies, and no-ops paid tiers', () => {
	expect(isSecondAgentStandardGiftActive(inTwoWeeks, now)).toBe(true)
	expect(isSecondAgentStandardGiftActive(yesterday, now)).toBe(false)
	expect(isSecondAgentStandardGiftActive(null, now)).toBe(false)

	expect(
		resolveEffectivePlanWithSecondAgentGift('free', null, inTwoWeeks, now),
	).toBe('standard')
	expect(
		resolveEffectivePlanWithSecondAgentGift('free', null, yesterday, now),
	).toBe('free')
	expect(
		resolveEffectivePlanWithSecondAgentGift(
			'free',
			'standard',
			inTwoWeeks,
			now,
		),
	).toBe('standard')
	expect(
		resolveEffectivePlanWithSecondAgentGift('free', 'pro', inTwoWeeks, now),
	).toBe('pro')
	expect(
		resolveEffectivePlanWithSecondAgentGift('max', null, inTwoWeeks, now),
	).toBe('max')
	expect(
		resolveEffectivePlanWithSecondAgentGift('pro', 'standard', inTwoWeeks, now),
	).toBe('pro')

	const applied = resolveSecondAgentStandardGiftWrite({
		manualPlan: 'free',
		stripePlan: null,
		now,
	})
	expect(applied.expiresAt).toBe(inTwoWeeks)

	// Already-paid Standard/Pro (and manual standard/pro/max): do not extend
	// Stripe. There is no existing trial-period helper.
	expect(
		resolveSecondAgentStandardGiftWrite({
			manualPlan: 'free',
			stripePlan: 'standard',
			now,
		}),
	).toEqual({ expiresAt: null })
	expect(
		resolveSecondAgentStandardGiftWrite({
			manualPlan: 'free',
			stripePlan: 'pro',
			now,
		}),
	).toEqual({ expiresAt: null })
	expect(
		resolveSecondAgentStandardGiftWrite({
			manualPlan: 'standard',
			stripePlan: null,
			now,
		}),
	).toEqual({ expiresAt: null })
	expect(
		resolveSecondAgentStandardGiftWrite({
			manualPlan: 'max',
			stripePlan: null,
			now,
		}),
	).toEqual({ expiresAt: null })

	expect(
		describeSecondAgentStandardGift({
			grantedAt: null,
			expiresAt: null,
			now,
		}),
	).toEqual({
		received: false,
		active: false,
		status: 'none',
		expiresAt: null,
		grantedAt: null,
	})
	expect(
		describeSecondAgentStandardGift({
			grantedAt: now.toISOString(),
			expiresAt: inTwoWeeks,
			now,
		}),
	).toEqual({
		received: true,
		active: true,
		status: 'active',
		expiresAt: inTwoWeeks,
		grantedAt: now.toISOString(),
	})
	expect(
		describeSecondAgentStandardGift({
			grantedAt: now.toISOString(),
			expiresAt: yesterday,
			now,
		}),
	).toEqual({
		received: true,
		active: false,
		status: 'expired',
		expiresAt: yesterday,
		grantedAt: now.toISOString(),
	})
	expect(
		describeSecondAgentStandardGift({
			grantedAt: now.toISOString(),
			expiresAt: null,
			now,
		}),
	).toEqual({
		received: true,
		active: false,
		status: 'already_paid',
		expiresAt: null,
		grantedAt: now.toISOString(),
	})
})
