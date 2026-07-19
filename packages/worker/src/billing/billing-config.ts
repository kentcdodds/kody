import {
	getPlanRank,
	parsePlanName,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import { type StripeSubscription } from './stripe-client.ts'

type BillingEnv = {
	STRIPE_SECRET_KEY?: string
	STRIPE_PERSONAL_PRICE_ID?: string
	STRIPE_PRO_PRICE_ID?: string
	STRIPE_PERSONAL_PAYMENT_LINK?: string
	STRIPE_PRO_PAYMENT_LINK?: string
}

const activeSubscriptionStatuses = new Set(['active', 'trialing'])

export function isBillingConfigured(env: BillingEnv) {
	return Boolean(env.STRIPE_SECRET_KEY?.trim())
}

export function getPersonalPriceId(env: BillingEnv) {
	return env.STRIPE_PERSONAL_PRICE_ID?.trim() || null
}

export function getProPriceId(env: BillingEnv) {
	return env.STRIPE_PRO_PRICE_ID?.trim() || null
}

export function getPersonalPaymentLink(env: BillingEnv) {
	return env.STRIPE_PERSONAL_PAYMENT_LINK?.trim() || null
}

export function getProPaymentLink(env: BillingEnv) {
	return env.STRIPE_PRO_PAYMENT_LINK?.trim() || null
}

/**
 * Append checkout attribution params to a static Stripe Payment Link.
 * Does not log the resulting URL (it contains the stable user id).
 */
export function buildPaymentLinkUrl(input: {
	baseUrl: string
	stableUserId: string
	email: string
}) {
	const url = new URL(input.baseUrl)
	url.searchParams.set('client_reference_id', input.stableUserId)
	url.searchParams.set('prefilled_email', input.email)
	return url.toString()
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
	priceIds: { personal: string | null; pro: string | null },
): PlanName | null {
	let matched: PlanName | null = null
	for (const item of subscription.items.data) {
		const priceId = item.price.id
		if (priceIds.personal && priceId === priceIds.personal) {
			matched = pickHigherPlan(matched, 'personal')
		}
		if (priceIds.pro && priceId === priceIds.pro) {
			matched = pickHigherPlan(matched, 'pro')
		}
	}
	if (matched) return matched
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
	const priceIds = {
		personal: getPersonalPriceId(env),
		pro: getProPriceId(env),
	}
	let stripePlan: PlanName | null = null
	let soonestCancelAt: number | null = null

	for (const subscription of subscriptions) {
		if (!activeSubscriptionStatuses.has(subscription.status)) continue
		stripePlan = pickHigherPlan(
			stripePlan,
			planFromSubscription(subscription, priceIds),
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
