import { readJson } from '#client/routes/account-approval-shared.ts'

const billingCheckoutApiPath = '/account/billing/checkout.json'

export type BillingInterval = 'month' | 'year'
/** Where `POST /account/billing/checkout.json` sends the browser next. */
type CheckoutMode = 'checkout' | 'portal_update' | 'portal'

type BillingCheckoutResult =
	| { ok: true; url: string; mode: CheckoutMode | null }
	| { ok: false; error: string }

const checkoutFallbackError = 'Unable to start checkout. Try again shortly.'

/**
 * Start Pro checkout. Existing subscribers get a prorated portal update
 * (or the plain portal when they hold more than one subscription).
 */
export async function requestProCheckout(
	interval: BillingInterval = 'month',
): Promise<BillingCheckoutResult> {
	try {
		const response = await fetch(billingCheckoutApiPath, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify({ plan: 'pro', interval }),
		})
		const payload = await readJson<{
			ok?: boolean
			url?: string
			mode?: CheckoutMode
			error?: string
		}>(response)
		if (response.ok && payload?.ok && typeof payload.url === 'string') {
			return { ok: true, url: payload.url, mode: payload.mode ?? null }
		}
		return {
			ok: false,
			error:
				typeof payload?.error === 'string' && payload.error.length > 0
					? payload.error
					: checkoutFallbackError,
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : checkoutFallbackError,
		}
	}
}
