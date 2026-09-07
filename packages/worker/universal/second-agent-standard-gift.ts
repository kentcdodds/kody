/**
 * Second-agent Standard gift: one 14-day public Standard overlay when a
 * user first reaches two unique inbound MCP OAuth clientIds.
 *
 * Enforcement composes {@link resolveEffectivePlan}. Paid Standard/Pro/max
 * are a no-op (no Stripe period extension — there is no existing trial
 * helper for that).
 */

import {
	getPlanRank,
	resolveEffectivePlan,
	type PlanName,
} from '#universal/plans.ts'

const secondAgentStandardGiftPlan = 'standard' satisfies PlanName

/** 14 days. Observed through grant `expires_at`, not this export alone. */
const secondAgentStandardGiftDurationMs = 14 * 24 * 60 * 60 * 1000

const secondAgentStandardGiftStatuses = [
	'none',
	'active',
	'expired',
	'already_paid',
] as const

type SecondAgentStandardGiftStatus =
	(typeof secondAgentStandardGiftStatuses)[number]

export type SecondAgentStandardGiftState = {
	/** True after the one gift attempt has been recorded. */
	received: boolean
	/** True while the overlay currently raises a free account to Standard. */
	active: boolean
	status: SecondAgentStandardGiftStatus
	expiresAt: string | null
	grantedAt: string | null
}

function addSecondAgentStandardGiftDuration(now: Date): Date {
	return new Date(now.getTime() + secondAgentStandardGiftDurationMs)
}

export function isSecondAgentStandardGiftActive(
	expiresAt: string | null | undefined,
	now: Date = new Date(),
) {
	if (!expiresAt) return false
	const expiresMs = Date.parse(expiresAt)
	return Number.isFinite(expiresMs) && expiresMs > now.getTime()
}

export function describeSecondAgentStandardGift(input: {
	grantedAt?: string | null
	expiresAt?: string | null
	now?: Date
}): SecondAgentStandardGiftState {
	const grantedAt = input.grantedAt?.trim() || null
	const expiresAt = input.expiresAt?.trim() || null
	if (!grantedAt) {
		return {
			received: false,
			active: false,
			status: 'none',
			expiresAt: null,
			grantedAt: null,
		}
	}
	if (!expiresAt) {
		return {
			received: true,
			active: false,
			status: 'already_paid',
			expiresAt: null,
			grantedAt,
		}
	}
	const active = isSecondAgentStandardGiftActive(expiresAt, input.now)
	return {
		received: true,
		active,
		status: active ? 'active' : 'expired',
		expiresAt,
		grantedAt,
	}
}

/**
 * Effective plan plus the second-agent overlay. The gift only raises a
 * lower-ranked plan to Standard; it never lowers paid or manual grants.
 */
export function resolveEffectivePlanWithSecondAgentGift(
	manualPlan: PlanName,
	stripePlan: string | null,
	giftExpiresAt: string | null | undefined,
	now: Date = new Date(),
): PlanName {
	const base = resolveEffectivePlan(manualPlan, stripePlan)
	if (
		isSecondAgentStandardGiftActive(giftExpiresAt, now) &&
		getPlanRank(secondAgentStandardGiftPlan) > getPlanRank(base)
	) {
		return secondAgentStandardGiftPlan
	}
	return base
}

/**
 * Whether the gift should overlay Standard (`applied`) or record a no-op
 * (`already_paid`). Paid Standard/Pro and manual standard/pro/max no-op:
 * there is no existing helper that extends a remaining Stripe period, and
 * mutating `trial_end` / period end is payment-adjacent.
 */
export function resolveSecondAgentStandardGiftWrite(input: {
	manualPlan: PlanName
	stripePlan: string | null
	now: Date
}): { expiresAt: string | null } {
	const effective = resolveEffectivePlan(input.manualPlan, input.stripePlan)
	if (getPlanRank(effective) >= getPlanRank(secondAgentStandardGiftPlan)) {
		return { expiresAt: null }
	}
	return {
		expiresAt: addSecondAgentStandardGiftDuration(input.now).toISOString(),
	}
}
