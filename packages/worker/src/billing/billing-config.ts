import { toHex } from '@kody-internal/shared/hex.ts'
import {
	getPlanRank,
	parsePlanName,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import { type StripeSubscription } from './stripe-client.ts'

type BillingEnv = {
	STRIPE_SECRET_KEY?: string
	STRIPE_PRO_PRICE_ID?: string
}

const activeSubscriptionStatuses = new Set(['active', 'trialing'])

export function isBillingConfigured(env: BillingEnv) {
	return Boolean(env.STRIPE_SECRET_KEY?.trim())
}

export function getProPriceId(env: BillingEnv) {
	return env.STRIPE_PRO_PRICE_ID?.trim() || null
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
	proPriceId: string | null,
): PlanName | null {
	if (proPriceId) {
		for (const item of subscription.items.data) {
			if (item.price.id === proPriceId) {
				return 'pro'
			}
		}
	}
	const metadataPlan = subscription.metadata?.['kody_plan']
	return parsePlanName(metadataPlan)
}

/**
 * Map Stripe subscriptions to the highest matching Kody plan among
 * active/trialing subscriptions, plus the soonest non-null cancel_at
 * (Unix seconds → ISO string) for display.
 */
export function resolveSubscriptionPlan(
	subscriptions: ReadonlyArray<StripeSubscription>,
	env: BillingEnv,
): { stripePlan: PlanName | null; cancelAt: string | null } {
	const proPriceId = getProPriceId(env)
	let stripePlan: PlanName | null = null
	let soonestCancelAt: number | null = null

	for (const subscription of subscriptions) {
		if (!activeSubscriptionStatuses.has(subscription.status)) continue
		stripePlan = pickHigherPlan(
			stripePlan,
			planFromSubscription(subscription, proPriceId),
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
	}
}
