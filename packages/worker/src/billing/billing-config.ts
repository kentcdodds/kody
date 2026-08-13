import { toHex } from '@kody-internal/shared/hex.ts'
import {
	getPlanRank,
	parseStripePlanName,
	type PlanName,
} from '#universal/plans.ts'
import { type StripeSubscription } from './stripe-client.ts'

type BillingEnv = {
	STRIPE_SECRET_KEY?: string
	STRIPE_STANDARD_PRICE_ID?: string
	STRIPE_STANDARD_YEARLY_PRICE_ID?: string
	STRIPE_PRO_PRICE_ID?: string
	STRIPE_PRO_YEARLY_PRICE_ID?: string
}

export type BillingInterval = 'month' | 'year'
export type PurchasablePlan = 'standard' | 'pro'

const activeSubscriptionStatuses = new Set(['active', 'trialing'])

/**
 * Retired production monthly prices that still have live subscribers.
 * Checkout uses the $12 / $29 monthly prices; these ids stay in Stripe and
 * must resolve to standard/pro so existing subscriptions do not drop to free.
 * Standard $5 (`price_1Tv3W2…`) has one customer through 2026-09-08.
 */
const retiredStandardPriceIds = ['price_1Tv3W2LAQpAnsYszSr4PGBkE'] as const
const retiredProPriceIds = ['price_1U1AISLAQpAnsYszIQvRJNhl'] as const

/** Higher rank = more useful UX signal when no active/trialing sub exists. */
const subscriptionStatusSignalRank: Record<string, number> = {
	past_due: 100,
	unpaid: 90,
	incomplete: 80,
	paused: 70,
	incomplete_expired: 60,
	canceled: 50,
}

export type ResolvedSubscriptionPlan = {
	stripePlan: PlanName | null
	cancelAt: string | null
	subscriptionStatus: string | null
}

export function isBillingConfigured(env: BillingEnv) {
	return Boolean(env.STRIPE_SECRET_KEY?.trim())
}

export function getStandardPriceId(env: BillingEnv) {
	return env.STRIPE_STANDARD_PRICE_ID?.trim() || null
}

export function getStandardYearlyPriceId(env: BillingEnv) {
	return env.STRIPE_STANDARD_YEARLY_PRICE_ID?.trim() || null
}

export function getProPriceId(env: BillingEnv) {
	return env.STRIPE_PRO_PRICE_ID?.trim() || null
}

export function getProYearlyPriceId(env: BillingEnv) {
	return env.STRIPE_PRO_YEARLY_PRICE_ID?.trim() || null
}

export function parseBillingInterval(value: unknown): BillingInterval | null {
	if (value === undefined || value === null || value === '') return 'month'
	if (value === 'month' || value === 'year') return value
	return null
}

export function getPurchasablePlans(env: BillingEnv): Array<PurchasablePlan> {
	return [
		...(getStandardPriceId(env) || getStandardYearlyPriceId(env)
			? (['standard'] as const)
			: []),
		...(getProPriceId(env) || getProYearlyPriceId(env)
			? (['pro'] as const)
			: []),
	]
}

export function getPriceIdForPlan(
	env: BillingEnv,
	plan: PurchasablePlan,
	interval: BillingInterval = 'month',
): string | null {
	switch (plan) {
		case 'standard':
			switch (interval) {
				case 'month':
					return getStandardPriceId(env)
				case 'year':
					return getStandardYearlyPriceId(env)
				default: {
					const exhaustive: never = interval
					throw new Error(`Unknown billing interval: ${String(exhaustive)}`)
				}
			}
		case 'pro':
			switch (interval) {
				case 'month':
					return getProPriceId(env)
				case 'year':
					return getProYearlyPriceId(env)
				default: {
					const exhaustive: never = interval
					throw new Error(`Unknown billing interval: ${String(exhaustive)}`)
				}
			}
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown purchasable plan: ${String(exhaustive)}`)
		}
	}
}

function collectPriceIds(
	ids: ReadonlyArray<string | null | undefined>,
): Array<string> {
	const seen = new Set<string>()
	const result: Array<string> = []
	for (const id of ids) {
		const trimmed = id?.trim()
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		result.push(trimmed)
	}
	return result
}

export function getMatchingPriceIdsForPlan(
	env: BillingEnv,
	plan: PurchasablePlan,
): Array<string> {
	switch (plan) {
		case 'standard':
			return collectPriceIds([
				getStandardPriceId(env),
				getStandardYearlyPriceId(env),
				...retiredStandardPriceIds,
			])
		case 'pro':
			return collectPriceIds([
				getProPriceId(env),
				getProYearlyPriceId(env),
				...retiredProPriceIds,
			])
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown purchasable plan: ${String(exhaustive)}`)
		}
	}
}

/**
 * Unguessable per-user checkout attribution value. The stable user id
 * alone is NOT sufficient (it is a plain SHA-256 of the account email, so
 * anyone who knows the email can derive it and mint checkout sessions that
 * would pass a naive comparison). Signing it with the deployment cookie
 * secret means only sessions created by this deployment for this user carry
 * a matching reference.
 */
export async function createBillingLinkReference(
	env: Pick<Env, 'COOKIE_SECRET'>,
	stableUserId: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(env.COOKIE_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`billing-link:${stableUserId}`),
	)
	return toHex(new Uint8Array(signature))
}

function pickHigherPlan(
	current: PlanName | null,
	candidate: PlanName | null,
): PlanName | null {
	if (!candidate) return current
	if (!current) return candidate
	return getPlanRank(candidate) > getPlanRank(current) ? candidate : current
}

function planFromSubscription(
	subscription: StripeSubscription,
	standardPriceIds: ReadonlyArray<string>,
	proPriceIds: ReadonlyArray<string>,
): PlanName | null {
	const standardPriceIdSet = new Set(standardPriceIds)
	const proPriceIdSet = new Set(proPriceIds)
	let matchedStandardPrice = false
	for (const item of subscription.items.data) {
		if (proPriceIdSet.has(item.price.id)) return 'pro'
		if (standardPriceIdSet.has(item.price.id)) {
			matchedStandardPrice = true
		}
	}
	if (matchedStandardPrice) return 'standard'

	// Price ids are the primary, unambiguous source of truth; `kody_plan`
	// metadata is the fallback for subscriptions whose price id rotated.
	const metadataPlan = subscription.metadata?.['kody_plan']
	return parseStripePlanName(metadataPlan)
}

function pickSubscriptionStatus(
	subscriptions: ReadonlyArray<StripeSubscription>,
): string | null {
	let hasActive = false
	let hasTrialing = false
	let bestSignal: string | null = null
	let bestRank = -1

	for (const subscription of subscriptions) {
		const status = subscription.status.trim()
		if (!status) continue
		if (status === 'active') {
			hasActive = true
			continue
		}
		if (status === 'trialing') {
			hasTrialing = true
			continue
		}
		const rank = subscriptionStatusSignalRank[status] ?? 1
		if (rank > bestRank) {
			bestRank = rank
			bestSignal = status
		}
	}

	if (hasActive) return 'active'
	if (hasTrialing) return 'trialing'
	return bestSignal
}

/**
 * Map Stripe subscriptions to the highest matching Kody plan among
 * active/trialing subscriptions, plus the soonest non-null cancel_at
 * (Unix seconds → ISO string) for display, and a UX-oriented
 * subscriptionStatus (prefer active/trialing, else highest-signal status
 * such as past_due).
 */
export function resolveSubscriptionPlan(
	subscriptions: ReadonlyArray<StripeSubscription>,
	env: BillingEnv,
): ResolvedSubscriptionPlan {
	const standardPriceIds = getMatchingPriceIdsForPlan(env, 'standard')
	const proPriceIds = getMatchingPriceIdsForPlan(env, 'pro')
	let stripePlan: PlanName | null = null
	let soonestCancelAt: number | null = null

	for (const subscription of subscriptions) {
		if (!activeSubscriptionStatuses.has(subscription.status)) continue
		stripePlan = pickHigherPlan(
			stripePlan,
			planFromSubscription(subscription, standardPriceIds, proPriceIds),
		)
		if (
			typeof subscription.cancel_at === 'number' &&
			Number.isFinite(subscription.cancel_at) &&
			(soonestCancelAt == null || subscription.cancel_at < soonestCancelAt)
		) {
			soonestCancelAt = subscription.cancel_at
		}
	}

	return {
		stripePlan,
		cancelAt:
			soonestCancelAt == null
				? null
				: new Date(soonestCancelAt * 1000).toISOString(),
		subscriptionStatus: pickSubscriptionStatus(subscriptions),
	}
}
