import { env } from 'cloudflare:test'
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
	// past_due keeps paid entitlements through Stripe's dunning window.
	expect(await readUserBilling(user.id)).toMatchObject({
		stripe_customer_id: 'cus_webhook',
		stripe_plan: 'pro',
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

test('invoice.paid rewards both parties once and ignores $0 trial invoices', async () => {
	const referrer = await seedUser({
		email: 'referrer-invoice-paid@example.com',
	})
	const referee = await seedUser({
		email: 'referee-invoice-paid@example.com',
		stripeCustomerId: 'cus_referral_invoice_paid',
	})
	await env.APP_DB.prepare(
		`INSERT INTO referrals (
			referrer_stable_user_id, referee_stable_user_id, created_at, status
		) VALUES (?, ?, ?, 'pending')`,
	)
		.bind(
			referrer.stableUserId,
			referee.stableUserId,
			new Date('2026-09-07T00:00:00.000Z').toISOString(),
		)
		.run()

	vi.stubGlobal('fetch', async () => {
		throw new Error('fetch should not run for invoice.paid')
	})

	const trialEvent = {
		id: 'evt_invoice_trial',
		type: 'invoice.paid',
		created: 1_778_000_000,
		data: {
			object: {
				id: 'in_trial',
				object: 'invoice',
				customer: 'cus_referral_invoice_paid',
				subscription: 'sub_referral',
				status: 'paid',
				amount_paid: 0,
				billing_reason: 'subscription_create',
			},
		},
	}
	const trial = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({ event: trialEvent }),
		now,
	})
	expect(trial).toEqual({ status: 200, body: { ok: true } })
	expect(
		await env.APP_DB.prepare(
			'SELECT status FROM referrals WHERE referee_stable_user_id = ?',
		)
			.bind(referee.stableUserId)
			.first<{ status: string }>(),
	).toEqual({ status: 'pending' })

	const paidEvent = {
		id: 'evt_invoice_paid',
		type: 'invoice.paid',
		created: 1_778_000_100,
		data: {
			object: {
				id: 'in_paid',
				object: 'invoice',
				customer: 'cus_referral_invoice_paid',
				subscription: 'sub_referral',
				status: 'paid',
				amount_paid: 2000,
				billing_reason: 'subscription_create',
			},
		},
	}
	const paid = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({ event: paidEvent }),
		now,
	})
	expect(paid).toEqual({ status: 200, body: { ok: true } })
	expect(
		await env.APP_DB.prepare(
			'SELECT status, reward_invoice_id FROM referrals WHERE referee_stable_user_id = ?',
		)
			.bind(referee.stableUserId)
			.first<{ status: string; reward_invoice_id: string | null }>(),
	).toEqual({
		status: 'rewarded',
		reward_invoice_id: 'in_paid',
	})
	const afterFirst = await env.APP_DB.prepare(
		`SELECT referral_standard_credit_expires_at FROM users WHERE id IN (?, ?)`,
	)
		.bind(referrer.id, referee.id)
		.all<{ referral_standard_credit_expires_at: string }>()
	expect(afterFirst.results).toHaveLength(2)
	expect(
		afterFirst.results.every(
			(row) =>
				row.referral_standard_credit_expires_at === '2026-08-24T12:00:00.000Z',
		),
	).toBe(true)

	const replay = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({
			event: {
				...paidEvent,
				id: 'evt_invoice_paid_replay',
				data: {
					object: {
						...paidEvent.data.object,
						id: 'in_paid_later',
					},
				},
			},
		}),
		now,
	})
	expect(replay).toEqual({ status: 200, body: { ok: true } })
	expect(
		await env.APP_DB.prepare(
			'SELECT status, reward_invoice_id FROM referrals WHERE referee_stable_user_id = ?',
		)
			.bind(referee.stableUserId)
			.first<{ status: string; reward_invoice_id: string | null }>(),
	).toEqual({
		status: 'rewarded',
		reward_invoice_id: 'in_paid',
	})

	vi.unstubAllGlobals()
})

test('invoice.paid returns 500 when a qualifying invoice has no linked user', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	silenceExpectedConsoleErrors([
		'stripe_webhook_process_failed',
		'stripe_webhook_invoice_paid_user_not_linked',
	])
	vi.stubGlobal('fetch', async () => {
		throw new Error('fetch should not run for an unlinked invoice.paid')
	})
	const result = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({
			event: {
				id: 'evt_invoice_unlinked',
				type: 'invoice.paid',
				created: 1_778_000_200,
				data: {
					object: {
						id: 'in_unlinked',
						object: 'invoice',
						customer: 'cus_not_linked_yet',
						subscription: 'sub_unlinked',
						status: 'paid',
						amount_paid: 1200,
						billing_reason: 'subscription_create',
					},
				},
			},
		}),
		now,
	})
	expect(result).toEqual({
		status: 500,
		body: { ok: false, error: 'Failed to process Stripe webhook event.' },
	})
	vi.unstubAllGlobals()
})

test('invoice.paid returns 500 when the referrer paid period cannot be loaded', async () => {
	silenceExpectedConsoleErrors([
		'stripe_webhook_process_failed',
		'stripe_api_error',
	])
	const referrer = await seedUser({
		email: 'referrer-period-fail@example.com',
		stripeCustomerId: 'cus_referrer_period_fail',
		stripePlan: 'standard',
	})
	const referee = await seedUser({
		email: 'referee-period-fail@example.com',
		stripeCustomerId: 'cus_referee_period_fail',
	})
	await env.APP_DB.prepare(
		`INSERT INTO referrals (
			referrer_stable_user_id, referee_stable_user_id, created_at, status
		) VALUES (?, ?, ?, 'pending')`,
	)
		.bind(referrer.stableUserId, referee.stableUserId, now.toISOString())
		.run()
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ error: 'stripe down' }, 500)),
	)

	const result = await handleStripeWebhookRequest({
		env: createWebhookEnv(),
		request: await signedWebhookRequest({
			event: {
				id: 'evt_invoice_referrer_period_fail',
				type: 'invoice.paid',
				created: 1_778_000_300,
				data: {
					object: {
						id: 'in_referrer_period_fail',
						object: 'invoice',
						customer: 'cus_referee_period_fail',
						subscription: 'sub_referrer_period_fail',
						status: 'paid',
						amount_paid: 2000,
						billing_reason: 'subscription_create',
					},
				},
			},
		}),
		now,
	})
	expect(result).toEqual({
		status: 500,
		body: { ok: false, error: 'Failed to process Stripe webhook event.' },
	})
	expect(await readWebhookEvent('evt_invoice_referrer_period_fail')).toBeNull()
	expect(
		await env.APP_DB.prepare(
			'SELECT status, credits_granted_at FROM referrals WHERE referee_stable_user_id = ?',
		)
			.bind(referee.stableUserId)
			.first<{ status: string; credits_granted_at: string | null }>(),
	).toEqual({ status: 'pending', credits_granted_at: null })

	vi.unstubAllGlobals()
})
