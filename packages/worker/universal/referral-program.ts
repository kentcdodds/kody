/**
 * Uncapped referral program: both parties earn one month of public Standard
 * after the referee's first qualifying paid invoice. Enforcement composes
 * {@link resolveEffectivePlanWithSecondAgentGift} with the later of the
 * second-agent gift and this stackable credit.
 */

import { dnsSafeUsernamePattern } from '@kody-internal/shared/public-urls.ts'
import {
	isSecondAgentStandardGiftActive,
	resolveEffectivePlanWithSecondAgentGift,
} from '#universal/second-agent-standard-gift.ts'
import { type PlanName } from '#universal/plans.ts'

/** 30 days. Observed through grant `expires_at`, not this export alone. */
export const referralStandardCreditDurationMs = 30 * 24 * 60 * 60 * 1000

const referralRejectReasons = [
	'self_referral',
	'same_email',
	'same_stripe_customer',
	'platform_referrer',
] as const

export type ReferralRejectReason = (typeof referralRejectReasons)[number]

export type ReferralProgramSummary = {
	shareUrl: string
	sharePath: string
	rewardedCount: number
	pendingCount: number
	creditExpiresAt: string | null
	creditActive: boolean
	referrals: Array<ReferralProgramListItem>
}

export type ReferralProgramListItem = {
	refereeUsername: string | null
	status: 'pending' | 'rewarded'
	createdAt: string
	rewardedAt: string | null
}

export function normalizeReferralCode(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const normalized = value.trim().toLowerCase()
	if (!normalized) return null
	if (!dnsSafeUsernamePattern.test(normalized)) return null
	return normalized
}

export function parseReferralCode(input: {
	searchParams?: URLSearchParams | null
	body?: unknown
}): string | null {
	const fromBody =
		input.body && typeof input.body === 'object'
			? (input.body as Record<string, unknown>)
			: null
	const params = input.searchParams ?? null
	const candidates = [
		params?.get('ref'),
		params?.get('referral'),
		fromBody?.referralCode,
		fromBody?.ref,
		fromBody?.referral,
	]
	for (const candidate of candidates) {
		const normalized = normalizeReferralCode(candidate)
		if (normalized) return normalized
	}
	return null
}

export function referralSharePath(username: string): string {
	const code = normalizeReferralCode(username)
	return code ? `/signup?ref=${encodeURIComponent(code)}` : '/signup'
}

export function laterIsoTimestamp(
	...values: Array<string | null | undefined>
): string | null {
	let bestMs: number | null = null
	let bestRaw: string | null = null
	for (const value of values) {
		const trimmed = value?.trim()
		if (!trimmed) continue
		const ms = Date.parse(trimmed)
		if (!Number.isFinite(ms)) continue
		if (bestMs == null || ms > bestMs) {
			bestMs = ms
			bestRaw = trimmed
		}
	}
	return bestRaw
}

export function isReferralStandardCreditActive(
	expiresAt: string | null | undefined,
	now: Date = new Date(),
) {
	return isSecondAgentStandardGiftActive(expiresAt, now)
}

/**
 * Next credit expiry: add 30 days to the latest of now, an unexpired
 * stacked credit, and an optional paid Stripe period end so a subscriber's
 * month starts after paid access rather than overlapping it.
 */
export function addReferralStandardCreditDuration(input: {
	now: Date
	currentExpiresAt?: string | null
	paidPeriodEndAt?: string | null
}): Date {
	const candidates = [input.now.getTime()]
	const currentMs = input.currentExpiresAt
		? Date.parse(input.currentExpiresAt)
		: Number.NaN
	if (Number.isFinite(currentMs) && currentMs > input.now.getTime()) {
		candidates.push(currentMs)
	}
	const periodMs = input.paidPeriodEndAt
		? Date.parse(input.paidPeriodEndAt)
		: Number.NaN
	if (Number.isFinite(periodMs) && periodMs > input.now.getTime()) {
		candidates.push(periodMs)
	}
	return new Date(Math.max(...candidates) + referralStandardCreditDurationMs)
}

export function resolveEffectivePlanWithStandardOverlays(
	manualPlan: PlanName,
	stripePlan: string | null,
	overlayExpiresAt: string | null | undefined,
	now: Date = new Date(),
): PlanName {
	return resolveEffectivePlanWithSecondAgentGift(
		manualPlan,
		stripePlan,
		overlayExpiresAt,
		now,
	)
}

/**
 * Collapse plus-tags and Gmail dots so `ada+1@gmail.com` and
 * `a.da@gmail.com` cannot refer each other.
 */
export function normalizeEmailForReferralFraud(email: string): string {
	const trimmed = email.trim().toLowerCase()
	const at = trimmed.lastIndexOf('@')
	if (at <= 0) return trimmed
	let local = trimmed.slice(0, at)
	const domain = trimmed.slice(at + 1)
	const plus = local.indexOf('+')
	if (plus >= 0) local = local.slice(0, plus)
	if (domain === 'gmail.com' || domain === 'googlemail.com') {
		return `${local.replaceAll('.', '')}@gmail.com`
	}
	return `${local}@${domain}`
}

export function unixSecondsToIso(value: unknown): string | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return null
	}
	return new Date(value * 1000).toISOString()
}
