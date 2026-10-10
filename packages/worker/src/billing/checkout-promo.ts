import { type BillingInterval } from '#worker/billing/billing-config.ts'
import {
	findActivePromotionCode,
	type StripeEnv,
} from '#worker/billing/stripe-client.ts'

/**
 * Promo codes for Pro checkout. Stripe can restrict a coupon to a product
 * but not to a price, and monthly and annual Pro are prices of one product.
 * A "100% off once" code typed on Stripe's page would make a whole year free.
 * So Checkout never shows Stripe's code box. The customer types the code on
 * the Kody billing page, and Kody applies it only to monthly checkouts.
 */

export const annualPromoRejection =
	'Promo codes apply to monthly billing only. Choose monthly to use this code.'

export const existingSubscriptionPromoRejection =
	'Promo codes apply to new subscriptions only. This organization already has one.'

const unknownPromoRejection = "That promo code isn't valid."
const expiredPromoRejection = 'That promo code has expired.'
const redeemedPromoRejection = 'That promo code has already been used.'

/** Customer-facing promo code text: trimmed, or null when the field was empty. */
export function parsePromoCodeInput(
	value: unknown,
): { ok: true; code: string | null } | { ok: false; error: string } {
	if (value === undefined || value === null) return { ok: true, code: null }
	if (typeof value !== 'string') {
		return { ok: false, error: unknownPromoRejection }
	}
	const code = value.trim()
	if (!code) return { ok: true, code: null }
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
		return { ok: false, error: unknownPromoRejection }
	}
	return { ok: true, code }
}

/** Codes are monthly-only. Checked before any Stripe call. */
export function promoIntervalRejection(interval: BillingInterval) {
	switch (interval) {
		case 'month':
			return null
		case 'year':
			return annualPromoRejection
		default: {
			const exhaustive: never = interval
			return exhaustive
		}
	}
}

/**
 * The Stripe promotion code id for `code`. Stripe enforces the product
 * restriction, expiry, and redemption limit again when the Checkout Session
 * is created; checking here gives the customer a specific message.
 */
export async function resolveCheckoutPromotionCode(
	env: StripeEnv,
	input: { code: string; now: Date },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	const promotion = await findActivePromotionCode(env, input.code)
	if (!promotion || !promotion.active) {
		return { ok: false, error: unknownPromoRejection }
	}
	if (
		promotion.expires_at != null &&
		promotion.expires_at * 1000 <= input.now.getTime()
	) {
		return { ok: false, error: expiredPromoRejection }
	}
	if (
		promotion.max_redemptions != null &&
		(promotion.times_redeemed ?? 0) >= promotion.max_redemptions
	) {
		return { ok: false, error: redeemedPromoRejection }
	}
	return { ok: true, id: promotion.id }
}

/** Shown when Stripe still rejects a validated code at session creation. */
export const promoRejectedByStripe =
	"That promo code can't be applied to this plan."
