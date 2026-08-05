import { toHex } from '@kody-internal/shared/hex.ts'
import {
	getPlanRank,
	parseStripePlanName,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import { type StripeSubscription } from './stripe-client.ts'

type BillingEnv = {
	STRIPE_SECRET_KEY?: string
	STRIPE_STANDARD_PRICE_ID?: string
	STRIPE_PRO_PRICE_ID?: string
}

const activeSubscriptionStatuses = new Set(['active', 'trialing'])

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

export function getProPriceId(env: BillingEnv) {
	return env.STRIPE_PRO_PRICE_ID?.trim() || null
}

export function getPurchasablePlans(
	env: BillingEnv,
): Array<'standard' | 'pro'> {
	return [
		...(getStandardPriceId(env) ? (['standard'] as const) : []),
		...(getProPriceId(env) ? (['pro'] as const) : []),
	]
}

export function getPriceIdForPlan(
	env: BillingEnv,
	plan: 'standard' | 'pro',
): string | null {
	switch (plan) {
		case 'standard':
			return getStandardPriceId(env)
		case 'pro':
			return getProPriceId(env)
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
	standardPriceId: string | null,
	proPriceId: string | null,
): PlanName | null {
	let matchedStandardPrice = false
	for (const item of subscription.items.data) {
		if (proPriceId && item.price.id === proPriceId) return 'pro'
		if (standardPriceId && item.price.id === standardPriceId) {
			matchedStandardPrice = true
		}
	}
	if (matchedStandardPrice) return 'standard'

	// Price ids are the current, unambiguous source of truth. `kody_plan`
	// metadata was written before the tier rename, so old partner means new
	// pro and old pro means standard.
	const metadataPlan = subscription.metadata?.['kody_plan']
	return parseStripePlanName(metadataPlan, { legacyMetadata: true })
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
	const standardPriceId = getStandardPriceId(env)
	const proPriceId = getProPriceId(env)
	let stripePlan: PlanName | null = null
	let soonestCancelAt: number | null = null

	for (const subscription of subscriptions) {
		if (!activeSubscriptionStatuses.has(subscription.status)) continue
		stripePlan = pickHigherPlan(
			stripePlan,
			planFromSubscription(subscription, standardPriceId, proPriceId),
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
