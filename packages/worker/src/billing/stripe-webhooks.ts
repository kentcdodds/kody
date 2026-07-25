/**
 * Platform Stripe billing webhook processing (not package inbound webhooks).
 *
 * Verifies Stripe-Signature against STRIPE_WEBHOOK_SECRET, processes the event
 * (handlers are idempotent), then records the event id so later deliveries can
 * short-circuit as duplicates. Failures do not insert, so Stripe can retry.
 */
import {
	any,
	nullable,
	object,
	optional,
	parseSafe,
	record,
	string,
} from 'remix/data-schema'
import { isBillingConfigured } from './billing-config.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSessionAttribution,
	refreshStripePlanForStripeCustomer,
} from './subscription-sync.ts'
import {
	StripeWebhookSignatureError,
	verifyStripeWebhookSignature,
} from './stripe-webhook-signature.ts'

const stripeEventSchema = object({
	id: string(),
	type: string(),
	data: object({
		object: record(string(), any()),
	}),
})

const checkoutSessionObjectSchema = object({
	id: string(),
	customer: optional(nullable(string())),
	client_reference_id: optional(nullable(string())),
	customer_email: optional(nullable(string())),
	customer_details: optional(
		nullable(
			object({
				email: optional(nullable(string())),
			}),
		),
	),
	metadata: optional(nullable(record(string(), string()))),
})

const customerObjectSchema = object({
	customer: optional(nullable(string())),
})

export type StripeWebhookProcessResult = {
	status: number
	body: { ok: boolean; duplicate?: boolean; ignored?: boolean; error?: string }
}

function readCustomerId(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim()
	return null
}

function readStringField(
	recordValue: Record<string, unknown>,
	key: string,
): string | null {
	const value = recordValue[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Records a successfully processed event. UNIQUE conflict means another
 * delivery already finished the same event — treat as duplicate success.
 */
export async function recordStripeWebhookEvent(input: {
	env: Env
	eventId: string
	eventType: string
	now?: Date
}): Promise<'recorded' | 'duplicate'> {
	const now = input.now ?? new Date()
	try {
		await input.env.APP_DB.prepare(
			`INSERT INTO stripe_webhook_events (event_id, event_type, processed_at)
			 VALUES (?, ?, ?)`,
		)
			.bind(input.eventId, input.eventType, now.toISOString())
			.run()
		return 'recorded'
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE constraint failed/i.test(message)) {
			return 'duplicate'
		}
		throw error
	}
}

async function handleCheckoutSessionCompleted(input: {
	env: Env
	object: Record<string, unknown>
	now?: Date
}) {
	const parsed = parseSafe(checkoutSessionObjectSchema, input.object)
	if (!parsed.success) {
		console.error('stripe_webhook_checkout_shape', {
			error: 'unexpected checkout session shape',
		})
		return
	}
	const session = parsed.value
	const customerEmail =
		session.customer_details?.email?.trim() ||
		session.customer_email?.trim() ||
		null
	const stableUserIdHint =
		session.metadata?.['kody_stable_user_id']?.trim() || null

	try {
		await linkStripeCustomerFromCheckoutSessionAttribution({
			env: input.env,
			sessionId: session.id,
			clientReferenceId: session.client_reference_id,
			stableUserIdHint,
			customerId: session.customer,
			customerEmail,
			now: input.now,
		})
	} catch (error) {
		if (error instanceof BillingLinkError) {
			switch (error.code) {
				case 'billing_not_configured':
				case 'missing_session':
				case 'client_reference_mismatch':
				case 'missing_customer':
				case 'customer_already_linked':
				case 'account_already_linked':
				case 'user_not_found':
					console.error('stripe_webhook_checkout_link_skipped', {
						code: error.code,
						sessionId: session.id,
					})
					return
				case 'stripe_error':
					throw error
				default: {
					const exhaustive: never = error.code
					throw new Error(
						`Unhandled BillingLinkError code: ${String(exhaustive)}`,
					)
				}
			}
		}
		throw error
	}
}

async function handleCustomerSubscriptionChange(input: {
	env: Env
	object: Record<string, unknown>
	now?: Date
}) {
	const parsed = parseSafe(customerObjectSchema, input.object)
	const customerId =
		(parsed.success ? readCustomerId(parsed.value.customer) : null) ??
		readStringField(input.object, 'customer')
	if (!customerId) {
		console.error('stripe_webhook_subscription_missing_customer')
		return
	}
	const result = await refreshStripePlanForStripeCustomer({
		env: input.env,
		customerId,
		now: input.now,
	})
	if (result.userId == null) {
		console.error('stripe_webhook_subscription_user_not_found', { customerId })
	}
}

async function handleInvoicePaymentFailed(input: {
	env: Env
	object: Record<string, unknown>
	now?: Date
}) {
	const parsed = parseSafe(customerObjectSchema, input.object)
	const customerId =
		(parsed.success ? readCustomerId(parsed.value.customer) : null) ??
		readStringField(input.object, 'customer')
	if (!customerId) {
		console.error('stripe_webhook_invoice_missing_customer')
		return
	}
	const result = await refreshStripePlanForStripeCustomer({
		env: input.env,
		customerId,
		now: input.now,
	})
	if (result.userId == null) {
		console.error('stripe_webhook_invoice_user_not_found', { customerId })
		return
	}
	console.error('stripe_webhook_invoice_payment_failed', {
		userId: result.userId,
		customerId,
		subscriptionStatus: result.resolved?.subscriptionStatus ?? null,
	})
}

export async function processStripeWebhookEvent(input: {
	env: Env
	eventType: string
	object: Record<string, unknown>
	now?: Date
}): Promise<void> {
	switch (input.eventType) {
		case 'checkout.session.completed':
			await handleCheckoutSessionCompleted({
				env: input.env,
				object: input.object,
				now: input.now,
			})
			return
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted':
			await handleCustomerSubscriptionChange({
				env: input.env,
				object: input.object,
				now: input.now,
			})
			return
		case 'invoice.payment_failed':
			await handleInvoicePaymentFailed({
				env: input.env,
				object: input.object,
				now: input.now,
			})
			return
		default:
			// Unknown types are acknowledged after a successful process+record.
			return
	}
}

/**
 * Full HTTP handler body for POST /webhooks/stripe.
 * Uses the raw request text for signature verification.
 */
export async function handleStripeWebhookRequest(input: {
	env: Env
	request: Request
	now?: Date
}): Promise<StripeWebhookProcessResult> {
	const secret = input.env.STRIPE_WEBHOOK_SECRET?.trim()
	if (!secret) {
		return {
			status: 503,
			body: { ok: false, error: 'Stripe webhooks are not configured.' },
		}
	}

	if (!isBillingConfigured(input.env)) {
		return {
			status: 503,
			body: { ok: false, error: 'Stripe billing is not configured.' },
		}
	}

	const rawBody = await input.request.text()
	try {
		await verifyStripeWebhookSignature({
			secret,
			signatureHeader: input.request.headers.get('stripe-signature'),
			rawBody,
			nowSeconds: input.now
				? Math.floor(input.now.valueOf() / 1000)
				: undefined,
		})
	} catch (error) {
		if (error instanceof StripeWebhookSignatureError) {
			return {
				status: 400,
				body: { ok: false, error: error.message },
			}
		}
		throw error
	}

	let parsedJson: unknown
	try {
		parsedJson = JSON.parse(rawBody) as unknown
	} catch {
		return {
			status: 400,
			body: { ok: false, error: 'Invalid JSON payload.' },
		}
	}

	const parsedEvent = parseSafe(stripeEventSchema, parsedJson)
	if (!parsedEvent.success) {
		return {
			status: 400,
			body: { ok: false, error: 'Unexpected Stripe event shape.' },
		}
	}

	const event = parsedEvent.value
	try {
		await processStripeWebhookEvent({
			env: input.env,
			eventType: event.type,
			object: event.data.object,
			now: input.now,
		})
	} catch (error) {
		console.error('stripe_webhook_process_failed', {
			eventId: event.id,
			eventType: event.type,
			error: error instanceof Error ? error.message : String(error),
		})
		return {
			status: 500,
			body: { ok: false, error: 'Failed to process Stripe webhook event.' },
		}
	}

	const record = await recordStripeWebhookEvent({
		env: input.env,
		eventId: event.id,
		eventType: event.type,
		now: input.now,
	})
	if (record === 'duplicate') {
		return { status: 200, body: { ok: true, duplicate: true } }
	}

	return { status: 200, body: { ok: true } }
}
