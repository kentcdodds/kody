/**
 * Minimal Stripe REST client (no SDK). Calls https://api.stripe.com/v1
 * (overridable via STRIPE_API_BASE_URL) with Bearer STRIPE_SECRET_KEY.
 * Responses are validated with remix/data-schema; only the fields Kody
 * needs are parsed.
 */
import {
	array,
	boolean,
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
	/** Stripe `error.code` (for example `resource_missing`) when the body had one. */
	readonly code: string | null
	/**
	 * Stripe `error.message` when the body had one. Many credit-note and refund
	 * validation failures come back as a bare `invalid_request_error` with no
	 * `code`, so callers that need to classify them read this instead. Never
	 * logged: it can embed object ids.
	 */
	readonly stripeMessage: string | null
	constructor(
		message: string,
		options: {
			status: number
			code?: string | null
			stripeMessage?: string | null
			cause?: unknown
		},
	) {
		super(message, { cause: options.cause })
		this.name = 'StripeApiError'
		this.status = options.status
		this.code = options.code ?? null
		this.stripeMessage = options.stripeMessage ?? null
	}
}

const stripeErrorBodySchema = object({
	error: object({ code: optional(string()), message: optional(string()) }),
})

function readStripeErrorBody(body: unknown): {
	code: string | null
	message: string | null
} {
	const parsed = parseSafe(stripeErrorBodySchema, body)
	if (!parsed.success) return { code: null, message: null }
	return {
		code: parsed.value.error.code ?? null,
		message: parsed.value.error.message ?? null,
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

const canceledSubscriptionSchema = object({
	id: string(),
	status: string(),
})

const deletedCustomerSchema = object({
	id: string(),
	deleted: boolean(),
})

const invoiceLineItemSchema = object({
	id: string(),
	amount: number(),
	period: object({
		start: number(),
		end: number(),
	}),
})

const paidInvoiceSchema = object({
	id: string(),
	amount_paid: number(),
	currency: string(),
	lines: object({
		data: array(invoiceLineItemSchema),
	}),
})

const paidInvoiceListSchema = object({
	data: array(paidInvoiceSchema),
})

const creditNoteSchema = object({
	id: string(),
	total: number(),
	currency: string(),
	status: string(),
	memo: nullable(string()),
	metadata: optional(record(string(), string())),
})

const creditNoteListSchema = object({
	data: array(creditNoteSchema),
})

// A preview is a credit note that was never persisted, so nothing about its
// identity is trusted; only the computed totals matter.
const creditNotePreviewSchema = object({
	total: number(),
	currency: string(),
})

export type StripeCheckoutSession = InferOutput<typeof checkoutSessionSchema>
export type StripeSubscription = InferOutput<typeof subscriptionSchema>
export type StripePaidInvoice = InferOutput<typeof paidInvoiceSchema>
export type StripeCreditNote = InferOutput<typeof creditNoteSchema>

/**
 * Marks credit notes Kody issues during account deletion so a retried
 * deletion can find the earlier one instead of refunding twice.
 */
export const accountDeletionCreditNoteMetadataKey = 'kody_account_deletion'
export const accountDeletionCreditNoteMemo =
	'Prorated refund for unused time after account deletion'

export function isAccountDeletionCreditNote(creditNote: StripeCreditNote) {
	return (
		creditNote.status === 'issued' &&
		(creditNote.metadata?.[accountDeletionCreditNoteMetadataKey] === '1' ||
			creditNote.memo === accountDeletionCreditNoteMemo)
	)
}

/**
 * Stripe rejects a credit note that would credit more than the invoice still
 * allows (an earlier refund or credit note already consumed it) with a bare
 * `invalid_request_error`; only the `charge_already_refunded` case carries a
 * code. Account deletion treats both as "nothing left to refund".
 */
export function isStripeNothingToRefundError(error: unknown) {
	if (!(error instanceof StripeApiError)) return false
	if (error.code === 'charge_already_refunded') return true
	if (error.status !== 400 || !error.stripeMessage) return false
	return /exceed|already (?:been )?(?:fully )?refunded|no (?:remaining|creditable|refundable)/i.test(
		error.stripeMessage,
	)
}

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
		method: 'DELETE' | 'GET' | 'POST'
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
	// Resource paths embed customer, subscription, or session ids; keep them
	// out of logs while preserving the endpoint name for reconciliation.
	const loggablePath = input.path.replace(
		/(checkout\/sessions|customers|subscriptions|invoices|credit_notes)\/(?!preview(?:$|[/?]))[^/?]+/,
		'$1/<redacted>',
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
		const stripeError = readStripeErrorBody(body)
		throw new StripeApiError(
			`Stripe API request failed with HTTP ${response.status}.`,
			{
				status: response.status,
				code: stripeError.code,
				stripeMessage: stripeError.message,
			},
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
		// Stripe Tax is active on the account; with no registrations it computes
		// 0 and tracks thresholds, and once a registration exists Checkout starts
		// collecting without a code change. Tax IDs let business customers apply
		// reverse charge. Promotion codes cost nothing to allow.
		'automatic_tax[enabled]': 'true',
		'tax_id_collection[enabled]': 'true',
		allow_promotion_codes: 'true',
	}
	// Stripe accepts either `customer` or `customer_email`, never both.
	if (customerId) {
		form.customer = customerId
		// Automatic tax and tax-id collection on an existing customer require
		// Checkout to be allowed to save the address and name it collects.
		form['customer_update[address]'] = 'auto'
		form['customer_update[name]'] = 'auto'
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

/**
 * Immediately cancels a subscription. Account deletion intentionally does not
 * use cancel_at_period_end because the user is relinquishing portal access and
 * all account state.
 *
 * Idempotent: a subscription Stripe no longer knows (`resource_missing`) is
 * treated as canceled so a retried account deletion does not fail on a
 * subscription an earlier attempt already removed.
 */
export async function cancelSubscription(
	env: StripeEnv,
	subscriptionId: string,
): Promise<void> {
	const trimmed = subscriptionId.trim()
	if (!trimmed) {
		throw new StripeApiError('Subscription id is required.', { status: 400 })
	}
	let body: unknown
	try {
		body = await stripeRequest(env, {
			method: 'DELETE',
			path: `/v1/subscriptions/${encodeURIComponent(trimmed)}`,
		})
	} catch (error) {
		if (error instanceof StripeApiError && error.code === 'resource_missing') {
			return
		}
		throw error
	}
	const parsed = parseSafe(canceledSubscriptionSchema, body)
	if (!parsed.success || parsed.value.status !== 'canceled') {
		throw new StripeApiError('Unexpected Stripe canceled subscription shape.', {
			status: 502,
		})
	}
}

/**
 * Returns the most recent paid invoice for a subscription (Stripe lists
 * newest first) or null when nothing has been paid yet, for example a trial
 * that has not converted. Only the fields the prorated-refund math needs are
 * parsed: `amount_paid`, `currency`, and each line's `amount` and service
 * `period`.
 */
export async function getLatestPaidInvoiceForSubscription(
	env: StripeEnv,
	subscriptionId: string,
): Promise<StripePaidInvoice | null> {
	const trimmed = subscriptionId.trim()
	if (!trimmed) {
		throw new StripeApiError('Subscription id is required.', { status: 400 })
	}
	const body = await stripeRequest(env, {
		method: 'GET',
		path: '/v1/invoices',
		query: {
			subscription: trimmed,
			status: 'paid',
			limit: '1',
		},
	})
	const parsed = parseSafe(paidInvoiceListSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe invoice list shape.', {
			status: 502,
		})
	}
	return parsed.value.data[0] ?? null
}

/**
 * Lists the credit notes already issued against an invoice so a retried
 * account deletion can recognise its own earlier refund (see
 * {@link isAccountDeletionCreditNote}).
 */
export async function listCreditNotesForInvoice(
	env: StripeEnv,
	invoiceId: string,
): Promise<Array<StripeCreditNote>> {
	const trimmed = invoiceId.trim()
	if (!trimmed) {
		throw new StripeApiError('Invoice id is required.', { status: 400 })
	}
	const body = await stripeRequest(env, {
		method: 'GET',
		path: '/v1/credit_notes',
		query: {
			invoice: trimmed,
			limit: '100',
		},
	})
	const parsed = parseSafe(creditNoteListSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe credit note list shape.', {
			status: 502,
		})
	}
	return parsed.value.data
}

function buildCreditNoteLineForm(input: {
	invoiceId: string
	invoiceLineItemId: string
	amount: number
}): Record<string, string> {
	return {
		invoice: input.invoiceId,
		'lines[0][type]': 'invoice_line_item',
		'lines[0][invoice_line_item]': input.invoiceLineItemId,
		'lines[0][amount]': String(input.amount),
	}
}

/**
 * Issues a credit note that refunds part of one invoice line item to the
 * original payment method. A credit note (rather than a raw refund) reverses
 * the line's tax proportionally and leaves the customer a document that
 * matches the invoice.
 *
 * `amount` is the tax-exclusive line amount to credit, in the smallest
 * currency unit. Stripe requires the refund to equal the credit note total
 * (line amount plus its share of tax), which is only known after Stripe
 * computes it, so the note is previewed first and the refund is set to that
 * total. The returned `total` is what the customer actually gets back.
 */
export async function createProratedRefundCreditNote(
	env: StripeEnv,
	input: {
		invoiceId: string
		invoiceLineItemId: string
		amount: number
		reason: 'duplicate' | 'fraudulent' | 'order_change' | 'product_unsatisfactory'
	},
): Promise<{ id: string; total: number; currency: string }> {
	const invoiceId = input.invoiceId.trim()
	const invoiceLineItemId = input.invoiceLineItemId.trim()
	if (!invoiceId) {
		throw new StripeApiError('Invoice id is required.', { status: 400 })
	}
	if (!invoiceLineItemId) {
		throw new StripeApiError('Invoice line item id is required.', {
			status: 400,
		})
	}
	if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
		throw new StripeApiError('Credit note amount must be a positive integer.', {
			status: 400,
		})
	}
	const lineForm = buildCreditNoteLineForm({
		invoiceId,
		invoiceLineItemId,
		amount: input.amount,
	})

	const previewBody = await stripeRequest(env, {
		method: 'GET',
		path: '/v1/credit_notes/preview',
		query: lineForm,
	})
	const preview = parseSafe(creditNotePreviewSchema, previewBody)
	if (!preview.success) {
		throw new StripeApiError('Unexpected Stripe credit note preview shape.', {
			status: 502,
		})
	}
	if (!Number.isSafeInteger(preview.value.total) || preview.value.total <= 0) {
		throw new StripeApiError(
			'Stripe credit note preview did not produce a refundable total.',
			{ status: 502 },
		)
	}

	const body = await stripeRequest(env, {
		method: 'POST',
		path: '/v1/credit_notes',
		form: {
			...lineForm,
			refund_amount: String(preview.value.total),
			reason: input.reason,
			memo: accountDeletionCreditNoteMemo,
			[`metadata[${accountDeletionCreditNoteMetadataKey}]`]: '1',
		},
	})
	const parsed = parseSafe(creditNoteSchema, body)
	if (!parsed.success) {
		throw new StripeApiError('Unexpected Stripe credit note shape.', {
			status: 502,
		})
	}
	return {
		id: parsed.value.id,
		total: parsed.value.total,
		currency: parsed.value.currency,
	}
}

/**
 * Permanently deletes a Stripe customer after its active subscriptions have
 * been canceled, preventing future invoices for an account that no longer
 * exists in Kody.
 */
export async function deleteCustomer(
	env: StripeEnv,
	customerId: string,
): Promise<void> {
	const trimmed = customerId.trim()
	if (!trimmed) {
		throw new StripeApiError('Customer id is required.', { status: 400 })
	}
	const body = await stripeRequest(env, {
		method: 'DELETE',
		path: `/v1/customers/${encodeURIComponent(trimmed)}`,
	})
	const parsed = parseSafe(deletedCustomerSchema, body)
	if (!parsed.success || !parsed.value.deleted) {
		throw new StripeApiError('Unexpected Stripe deleted customer shape.', {
			status: 502,
		})
	}
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
