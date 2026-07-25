/**
 * Minimal Stripe REST client (no SDK). Calls https://api.stripe.com/v1
 * (overridable via STRIPE_API_BASE_URL) with Bearer STRIPE_SECRET_KEY.
 * Responses are validated with remix/data-schema; only the fields Kody
 * needs are parsed.
 */
import {
	array,
	nullable,
	number,
	object,
	optional,
	parseSafe,
	record,
	string,
	type InferOutput,
} from 'remix/data-schema'

const defaultStripeApiBaseUrl = 'https://api.stripe.com'

export class StripeApiError extends Error {
	readonly status: number
	constructor(message: string, options: { status: number; cause?: unknown }) {
		super(message, { cause: options.cause })
		this.name = 'StripeApiError'
		this.status = options.status
	}
}

export class BillingNotConfiguredError extends Error {
	constructor() {
		super('Stripe billing is not configured on this deployment.')
		this.name = 'BillingNotConfiguredError'
	}
}

type StripeEnv = {
	STRIPE_SECRET_KEY?: string
	STRIPE_API_BASE_URL?: string
}

const checkoutSessionSchema = object({
	id: string(),
	customer: nullable(string()),
	client_reference_id: nullable(string()),
})

const createdCheckoutSessionSchema = object({
	id: string(),
	url: nullable(string()),
})

const subscriptionItemSchema = object({
	price: object({
		id: string(),
	}),
})

const subscriptionSchema = object({
	id: string(),
	status: string(),
	cancel_at: nullable(number()),
	metadata: optional(record(string(), string())),
	items: object({
		data: array(subscriptionItemSchema),
	}),
})

const subscriptionListSchema = object({
	data: array(subscriptionSchema),
})

const billingPortalSessionSchema = object({
	url: string(),
})

export type StripeCheckoutSession = InferOutput<typeof checkoutSessionSchema>
export type StripeSubscription = InferOutput<typeof subscriptionSchema>

function resolveStripeApiBaseUrl(env: StripeEnv) {
	return (env.STRIPE_API_BASE_URL?.trim() || defaultStripeApiBaseUrl).replace(
		/\/$/,
		'',
	)
}

function requireStripeSecretKey(env: StripeEnv) {
	const key = env.STRIPE_SECRET_KEY?.trim()
	if (!key) throw new BillingNotConfiguredError()
	return key
}

async function stripeRequest(
	env: StripeEnv,
	input: {
		method: 'GET' | 'POST'
		path: string
		query?: Record<string, string>
		form?: Record<string, string>
	},
): Promise<unknown> {
	const secretKey = requireStripeSecretKey(env)
	const url = new URL(`${resolveStripeApiBaseUrl(env)}${input.path}`)
	if (input.query) {
		for (const [key, value] of Object.entries(input.query)) {
			url.searchParams.set(key, value)
		}
	}

	const headers: Record<string, string> = {
		accept: 'application/json',
		authorization: `Bearer ${secretKey}`,
	}

	const init: RequestInit = {
		method: input.method,
		headers,
		// A hung Stripe endpoint must not block billing page loads, portal
		// redirects, or the sequential cron sweep.
		signal: AbortSignal.timeout(10_000),
	}

	if (input.method === 'POST' && input.form) {
		headers['content-type'] = 'application/x-www-form-urlencoded'
		init.body = new URLSearchParams(input.form).toString()
	}

	const response = await fetch(url.toString(), init)
	const text = await response.text()
	// Checkout session paths embed the session id; keep ids out of logs.
	const loggablePath = input.path.replace(
		/(checkout\/sessions\/)[^/?]+/,
		'$1<redacted>',
	)
	let body: unknown = null
	if (text) {
		try {
			body = JSON.parse(text) as unknown
		} catch (error) {
			console.error('stripe_api_invalid_json', {
				status: response.status,
				path: loggablePath,
			})
			throw new StripeApiError('Stripe returned a non-JSON response.', {
				status: response.status,
				cause: error,
			})
		}
	}

	if (!response.ok) {
		console.error('stripe_api_error', {
			status: response.status,
			path: loggablePath,
		})
		throw new StripeApiError(
			`Stripe API request failed with HTTP ${response.status}.`,
			{ status: response.status },
		)
	}

	return body
}

export async function getCheckoutSession(
	env: StripeEnv,
	sessionId: string,
): Promise<StripeCheckoutSession> {
	const trimmed = sessionId.trim()
	if (!trimmed) {
		throw new StripeApiError('Checkout session id is required.', {
			status: 400,
		})
	}
	const body = await stripeRequest(env, {
		method: 'GET',
		path: `/v1/checkout/sessions/${encodeURIComponent(trimmed)}`,
	})
	const parsed = parseSafe(checkoutSessionSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe checkout session shape.', {
			status: 502,
		})
	}
	return parsed.value
}

/**
 * Creates a Stripe Checkout Session (mode=subscription) for an authenticated
 * subscribe flow. `success_url` must include the literal placeholder text
 * `{CHECKOUT_SESSION_ID}` so Stripe can substitute the session id on redirect.
 *
 * URLSearchParams encodes braces as `%7B` / `%7D` in the form body
 * (`session_id=%7BCHECKOUT_SESSION_ID%7D`). That is fine: Stripe decodes form
 * values before storing them, and placeholder substitution runs on the
 * decoded stored URL.
 */
export async function createCheckoutSession(
	env: StripeEnv,
	input: {
		priceId: string
		clientReferenceId: string
		successUrl: string
		cancelUrl: string
		customerId?: string
		customerEmail?: string
		/** Opaque session metadata (e.g. kody_stable_user_id for webhook lookup). */
		metadata?: Record<string, string>
	},
): Promise<{ id: string; url: string }> {
	const priceId = input.priceId.trim()
	const clientReferenceId = input.clientReferenceId.trim()
	const successUrl = input.successUrl.trim()
	const cancelUrl = input.cancelUrl.trim()
	const customerId = input.customerId?.trim() || undefined
	const customerEmail = input.customerEmail?.trim() || undefined
	if (!priceId) {
		throw new StripeApiError('Price id is required.', { status: 400 })
	}
	if (!clientReferenceId) {
		throw new StripeApiError('Client reference id is required.', {
			status: 400,
		})
	}
	if (!successUrl) {
		throw new StripeApiError('Success URL is required.', { status: 400 })
	}
	if (!cancelUrl) {
		throw new StripeApiError('Cancel URL is required.', { status: 400 })
	}

	const form: Record<string, string> = {
		mode: 'subscription',
		'line_items[0][price]': priceId,
		'line_items[0][quantity]': '1',
		client_reference_id: clientReferenceId,
		success_url: successUrl,
		cancel_url: cancelUrl,
	}
	// Stripe accepts either `customer` or `customer_email`, never both.
	if (customerId) {
		form.customer = customerId
	} else if (customerEmail) {
		form.customer_email = customerEmail
	}
	if (input.metadata) {
		for (const [key, value] of Object.entries(input.metadata)) {
			const trimmedKey = key.trim()
			const trimmedValue = value.trim()
			if (!trimmedKey || !trimmedValue) continue
			form[`metadata[${trimmedKey}]`] = trimmedValue
		}
	}

	const body = await stripeRequest(env, {
		method: 'POST',
		path: '/v1/checkout/sessions',
		form,
	})
	const parsed = parseSafe(createdCheckoutSessionSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe checkout session shape.', {
			status: 502,
		})
	}
	const url = parsed.value.url?.trim()
	if (!url) {
		throw new StripeApiError('Stripe checkout session did not include a URL.', {
			status: 502,
		})
	}
	return { id: parsed.value.id, url }
}

/**
 * Lists subscriptions for a customer with `status=all`, then callers filter
 * to `active` / `trialing`. Using status=all avoids a second request for
 * trialing while still letting canceled history contribute nothing once
 * filtered.
 */
export async function listSubscriptions(
	env: StripeEnv,
	customerId: string,
): Promise<Array<StripeSubscription>> {
	const trimmed = customerId.trim()
	if (!trimmed) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	const body = await stripeRequest(env, {
		method: 'GET',
		path: '/v1/subscriptions',
		query: {
			customer: trimmed,
			status: 'all',
			limit: '100',
		},
	})
	const parsed = parseSafe(subscriptionListSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe subscriptions list shape.', {
			status: 502,
		})
	}
	return parsed.value.data
}

export async function createBillingPortalSession(
	env: StripeEnv,
	input: { customerId: string; returnUrl: string },
): Promise<{ url: string }> {
	const customerId = input.customerId.trim()
	const returnUrl = input.returnUrl.trim()
	if (!customerId) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	if (!returnUrl) {
		throw new StripeApiError('Return URL is required.', { status: 400 })
	}
	const body = await stripeRequest(env, {
		method: 'POST',
		path: '/v1/billing_portal/sessions',
		form: {
			customer: customerId,
			return_url: returnUrl,
		},
	})
	const parsed = parseSafe(billingPortalSessionSchema, body)
	if (!parsed.success) {
		throw new StripeApiError(
			'Unexpected Stripe billing portal session shape.',
			{
				status: 502,
			},
		)
	}
	return parsed.value
}
