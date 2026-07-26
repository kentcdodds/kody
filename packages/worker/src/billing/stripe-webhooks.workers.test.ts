import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createBillingLinkReference } from './billing-config.ts'
import { buildStripeWebhookSignatureHeader } from './stripe-webhook-signature.ts'
import { handleStripeWebhookRequest } from './stripe-webhooks.ts'

const webhookSecret = 'whsec_test_workers_secret'
const now = new Date('2026-07-25T12:00:00.000Z')

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function createWebhookEnv(
	overrides: {
		STRIPE_SECRET_KEY?: string
		STRIPE_WEBHOOK_SECRET?: string
		STRIPE_PRO_PRICE_ID?: string
		STRIPE_API_BASE_URL?: string
	} = {},
): Env {
	return {
		...env,
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_WEBHOOK_SECRET: webhookSecret,
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_API_BASE_URL: 'https://stripe.mock',
		...overrides,
	}
}

async function seedUser(input: {
	email: string
	stripeCustomerId?: string | null
	stripePlan?: string | null
}) {
	await ensureEntitlementTestSchema(env.APP_DB)
	const stableUserId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, email_verified_at, stable_user_id, plan,
			stripe_customer_id, stripe_plan, stripe_plan_refreshed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`wh-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			'test-password-hash',
			now.toISOString(),
			stableUserId,
			'free',
			input.stripeCustomerId ?? null,
			input.stripePlan ?? null,
			null,
		)
		.run()
	const row = await env.APP_DB.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(input.email)
		.first<{ id: number }>()
	if (!row) throw new Error(`Failed to seed user ${input.email}`)
	return {
		id: row.id,
		email: input.email,
		stableUserId,
		linkReference: await createBillingLinkReference(env, stableUserId),
	}
}

async function readUserBilling(userId: number) {
	return env.APP_DB.prepare(
		`SELECT stripe_customer_id, stripe_plan, stripe_plan_refreshed_at
		 FROM users WHERE id = ?`,
	)
		.bind(userId)
		.first<{
			stripe_customer_id: string | null
			stripe_plan: string | null
			stripe_plan_refreshed_at: string | null
		}>()
}

async function readWebhookEvent(eventId: string) {
	return env.APP_DB.prepare(
		`SELECT event_id, event_type FROM stripe_webhook_events WHERE event_id = ?`,
	)
		.bind(eventId)
		.first<{ event_id: string; event_type: string }>()
}

function stubStripeFetch(input: {
	checkout?: unknown
	subscriptions?: unknown
}) {
	const fetchStub = vi.fn(async (request: RequestInfo | URL) => {
		const url = String(request)
		if (url.includes('/v1/checkout/sessions/')) {
			return jsonResponse(
				input.checkout ?? {
					id: 'cs_test',
					customer: 'cus_linked',
					client_reference_id: null,
				},
			)
		}
		if (url.includes('/v1/subscriptions')) {
			return jsonResponse(
				input.subscriptions ?? {
					data: [
						{
							id: 'sub_1',
							status: 'active',
							cancel_at: null,
							items: {
								data: [{ price: { id: 'price_pro' } }],
							},
						},
					],
				},
			)
		}
		return jsonResponse({ error: 'unexpected stripe path' }, 500)
	})
	vi.stubGlobal('fetch', fetchStub)
	return fetchStub
}

async function signedWebhookRequest(input: {
	event: Record<string, unknown>
	secret?: string
}) {
	const rawBody = JSON.stringify(input.event)
	const signature = await buildStripeWebhookSignatureHeader({
		secret: input.secret ?? webhookSecret,
		rawBody,
		timestamp: Math.floor(now.valueOf() / 1000),
	})
	return new Request('https://test.kody.dev/webhooks/stripe', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'stripe-signature': signature,
		},
		body: rawBody,
	})
}

test('stripe webhook verifies signature, links checkout, refreshes subscription, and is idempotent', async () => {
	// Guard: returns 503 when webhook secret is not configured.
	await ensureEntitlementTestSchema(env.APP_DB)
	const unconfigured = await handleStripeWebhookRequest({
		env: createWebhookEnv({ STRIPE_WEBHOOK_SECRET: '' }),
		request: new Request('https://test.kody.dev/webhooks/stripe', {
			method: 'POST',
			body: '{}',
		}),
		now,
	})
	expect(unconfigured.status).toBe(503)
	expect(unconfigured.body.ok).toBe(false)

	// Main journey: checkout completion, subscription update, unknown event, bad signature.
	const email = `wh-checkout-${crypto.randomUUID()}@example.com`
	const user = await seedUser({ email })
	stubStripeFetch({
		checkout: {
			id: 'cs_webhook',
			customer: 'cus_webhook',
			client_reference_id: user.linkReference,
		},
		subscriptions: {
			data: [
				{
					id: 'sub_webhook',
					status: 'active',
					cancel_at: null,
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			],
		},
	})

	const checkoutEvent = {
		id: `evt_checkout_${crypto.randomUUID()}`,
		type: 'checkout.session.completed',
		data: {
			object: {
				id: 'cs_webhook',
				customer: 'cus_webhook',
				client_reference_id: user.linkReference,
				customer_email: email,
				metadata: { kody_stable_user_id: user.stableUserId },
			},
		},
	}

	const first = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({ event: checkoutEvent }),
		now,
	})
	expect(first).toEqual({ status: 200, body: { ok: true } })
	expect(await readUserBilling(user.id)).toEqual({
		stripe_customer_id: 'cus_webhook',
		stripe_plan: 'pro',
		stripe_plan_refreshed_at: now.toISOString(),
	})
	expect(await readWebhookEvent(checkoutEvent.id)).toEqual({
		event_id: checkoutEvent.id,
		event_type: 'checkout.session.completed',
	})

	const duplicate = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({ event: checkoutEvent }),
		now,
	})
	expect(duplicate).toEqual({
		status: 200,
		body: { ok: true, duplicate: true },
	})

	stubStripeFetch({
		subscriptions: {
			data: [
				{
					id: 'sub_webhook',
					status: 'past_due',
					cancel_at: null,
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			],
		},
	})
	const updatedEvent = {
		id: `evt_sub_${crypto.randomUUID()}`,
		type: 'customer.subscription.updated',
		data: {
			object: {
				id: 'sub_webhook',
				customer: 'cus_webhook',
				status: 'past_due',
			},
		},
	}
	const updated = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({ event: updatedEvent }),
		now,
	})
	expect(updated).toEqual({ status: 200, body: { ok: true } })
	expect(await readUserBilling(user.id)).toMatchObject({
		stripe_customer_id: 'cus_webhook',
		stripe_plan: null,
		stripe_plan_refreshed_at: now.toISOString(),
	})

	const unknownEvent = {
		id: `evt_unknown_${crypto.randomUUID()}`,
		type: 'radar.early_fraud_warning.created',
		data: { object: { id: 'issfr_1' } },
	}
	const unknown = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({ event: unknownEvent }),
		now,
	})
	expect(unknown).toEqual({ status: 200, body: { ok: true } })
	expect(await readWebhookEvent(unknownEvent.id)).toEqual({
		event_id: unknownEvent.id,
		event_type: 'radar.early_fraud_warning.created',
	})

	const badSig = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({
			event: {
				id: `evt_bad_${crypto.randomUUID()}`,
				type: 'checkout.session.completed',
				data: { object: { id: 'cs_x' } },
			},
			secret: 'whsec_wrong_secret',
		}),
		now,
	})
	expect(badSig.status).toBe(400)
	expect(badSig.body.ok).toBe(false)

	vi.unstubAllGlobals()
})

test('stripe webhook process failure returns 500 without recording the event', async () => {
	silenceExpectedConsoleErrors([
		'stripe_api_error',
		'stripe_webhook_process_failed',
	])
	const email = `wh-fail-${crypto.randomUUID()}@example.com`
	const user = await seedUser({
		email,
		stripeCustomerId: 'cus_fail_retry',
	})
	const eventId = `evt_fail_${crypto.randomUUID()}`
	const event = {
		id: eventId,
		type: 'customer.subscription.updated',
		data: {
			object: {
				id: 'sub_fail',
				customer: 'cus_fail_retry',
				status: 'active',
			},
		},
	}
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ error: 'stripe down' }, 500)),
	)

	const result = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({ event }),
		now,
	})
	expect(result.status).toBe(500)
	expect(result.body.ok).toBe(false)
	expect(await readWebhookEvent(eventId)).toBeNull()

	// A later delivery must still be able to process after the failed attempt
	// (no stuck claim that would ack duplicates with 200).
	stubStripeFetch({
		subscriptions: {
			data: [
				{
					id: 'sub_fail',
					status: 'active',
					cancel_at: null,
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			],
		},
	})
	const retry = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({ event }),
		now,
	})
	expect(retry).toEqual({ status: 200, body: { ok: true } })
	expect(await readWebhookEvent(eventId)).toEqual({
		event_id: eventId,
		event_type: 'customer.subscription.updated',
	})
	expect(await readUserBilling(user.id)).toMatchObject({
		stripe_customer_id: 'cus_fail_retry',
		stripe_plan: 'pro',
	})

	vi.unstubAllGlobals()
})
