import { env, runInDurableObject } from 'cloudflare:test'
import { expect, test, vi } from 'vitest'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { createBillingLinkReference } from './billing-config.ts'
import { StripeApiError } from './stripe-client.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSession,
} from './subscription-sync.ts'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function createBillingEnv(
	overrides: {
		STRIPE_SECRET_KEY?: string
		STRIPE_PRO_PRICE_ID?: string
		STRIPE_API_BASE_URL?: string
		STRIPE_PLAN_REFRESH?: Env['STRIPE_PLAN_REFRESH']
	} = {},
): Env {
	return {
		...env,
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_API_BASE_URL: 'https://stripe.mock',
		...overrides,
	}
}

async function seedUser(input: {
	email: string
	plan?: 'pro' | 'max'
	stripeCustomerId?: string | null
	stripePlan?: string | null
	stripePlanRefreshedAt?: string | null
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
			`billing-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			'test-password-hash',
			new Date().toISOString(),
			stableUserId,
			input.plan ?? 'max',
			input.stripeCustomerId ?? null,
			input.stripePlan ?? null,
			input.stripePlanRefreshedAt ?? null,
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

function stubStripeFetch(input: {
	checkout?: unknown
	subscriptions?: unknown
	checkoutStatus?: number
	subscriptionsStatus?: number
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
				input.checkoutStatus ?? 200,
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
				input.subscriptionsStatus ?? 200,
			)
		}
		return jsonResponse({ error: 'unexpected stripe path' }, 500)
	})
	vi.stubGlobal('fetch', fetchStub)
	return fetchStub
}

async function expectBillingLinkError(
	promise: Promise<unknown>,
	code: BillingLinkError['code'],
) {
	const error = await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof BillingLinkError)) {
		throw new Error('Expected BillingLinkError')
	}
	expect(error.code).toBe(code)
}

test('linkStripeCustomerFromCheckoutSession links customer and refreshes stripe_plan', async () => {
	const email = `link-happy-${crypto.randomUUID()}@example.com`
	const user = await seedUser({ email, plan: 'pro' })
	const now = new Date('2026-07-19T12:00:00.000Z')
	stubStripeFetch({
		checkout: {
			id: 'cs_happy',
			customer: 'cus_happy',
			client_reference_id: user.linkReference,
		},
		subscriptions: {
			data: [
				{
					id: 'sub_happy',
					status: 'active',
					cancel_at: null,
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			],
		},
	})

	const result = await linkStripeCustomerFromCheckoutSession({
		env: createBillingEnv(),
		user,
		sessionId: 'cs_happy',
		now,
	})
	expect(result).toEqual({
		stripePlan: 'pro',
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	const row = await readUserBilling(user.id)
	expect(row).toEqual({
		stripe_customer_id: 'cus_happy',
		stripe_plan: 'pro',
		stripe_plan_refreshed_at: now.toISOString(),
	})
	const refreshAlarm = env.STRIPE_PLAN_REFRESH.get(
		env.STRIPE_PLAN_REFRESH.idFromName(user.stableUserId),
	)
	expect(
		await runInDurableObject(refreshAlarm, async (_instance, state) =>
			state.storage.getAlarm(),
		),
	).toBeTypeOf('number')

	vi.unstubAllGlobals()
})

test('checkout linking surfaces Stripe failure when its retry alarm cannot be armed', async () => {
	const email = `link-no-backstop-${crypto.randomUUID()}@example.com`
	const user = await seedUser({ email, plan: 'pro' })
	stubStripeFetch({
		checkout: {
			id: 'cs_no_backstop',
			customer: 'cus_no_backstop',
			client_reference_id: user.linkReference,
		},
		subscriptions: { error: 'stripe down' },
		subscriptionsStatus: 500,
	})
	consoleError.mockImplementation(() => {})
	const schedule = vi.fn(async () => {
		throw new Error('alarm unavailable')
	})
	const billingEnv = createBillingEnv({
		STRIPE_PLAN_REFRESH: {
			idFromName: env.STRIPE_PLAN_REFRESH.idFromName.bind(
				env.STRIPE_PLAN_REFRESH,
			),
			get: () => ({ schedule }),
		} as unknown as Env['STRIPE_PLAN_REFRESH'],
	})

	await expect(
		linkStripeCustomerFromCheckoutSession({
			env: billingEnv,
			user,
			sessionId: 'cs_no_backstop',
		}),
	).rejects.toBeInstanceOf(StripeApiError)
	expect(schedule).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'stripe_plan_refresh_schedule_failed',
		expect.objectContaining({ userId: user.stableUserId }),
	)

	vi.unstubAllGlobals()
})

test('linkStripeCustomerFromCheckoutSession rejects unsafe checkout links without mutating users', async () => {
	const billingEnv = createBillingEnv()

	{
		const email = `link-mismatch-${crypto.randomUUID()}@example.com`
		const user = await seedUser({ email })
		stubStripeFetch({
			checkout: {
				id: 'cs_mismatch',
				customer: 'cus_mismatch',
				client_reference_id: 'someone-else',
			},
		})

		await expectBillingLinkError(
			linkStripeCustomerFromCheckoutSession({
				env: billingEnv,
				user,
				sessionId: 'cs_mismatch',
			}),
			'client_reference_mismatch',
		)
		expect(await readUserBilling(user.id)).toMatchObject({
			stripe_customer_id: null,
			stripe_plan: null,
		})
		vi.unstubAllGlobals()
	}

	{
		const email = `link-missing-cus-${crypto.randomUUID()}@example.com`
		const user = await seedUser({ email })
		stubStripeFetch({
			checkout: {
				id: 'cs_no_customer',
				customer: null,
				client_reference_id: user.linkReference,
			},
		})

		await expectBillingLinkError(
			linkStripeCustomerFromCheckoutSession({
				env: billingEnv,
				user,
				sessionId: 'cs_no_customer',
			}),
			'missing_customer',
		)
		vi.unstubAllGlobals()
	}

	{
		const claimedEmail = `link-claimed-${crypto.randomUUID()}@example.com`
		const claimantEmail = `link-claimant-${crypto.randomUUID()}@example.com`
		await seedUser({
			email: claimedEmail,
			stripeCustomerId: 'cus_already',
		})
		const claimant = await seedUser({ email: claimantEmail })
		stubStripeFetch({
			checkout: {
				id: 'cs_already',
				customer: 'cus_already',
				client_reference_id: claimant.linkReference,
			},
		})

		await expectBillingLinkError(
			linkStripeCustomerFromCheckoutSession({
				env: billingEnv,
				user: claimant,
				sessionId: 'cs_already',
			}),
			'customer_already_linked',
		)
		expect(await readUserBilling(claimant.id)).toMatchObject({
			stripe_customer_id: null,
		})
		vi.unstubAllGlobals()
	}

	{
		const email = `link-replace-${crypto.randomUUID()}@example.com`
		const user = await seedUser({
			email,
			stripeCustomerId: 'cus_original',
			stripePlan: 'pro',
		})
		stubStripeFetch({
			checkout: {
				id: 'cs_replacement',
				customer: 'cus_other',
				client_reference_id: user.linkReference,
			},
		})

		await expectBillingLinkError(
			linkStripeCustomerFromCheckoutSession({
				env: billingEnv,
				user,
				sessionId: 'cs_replacement',
			}),
			'account_already_linked',
		)
		expect(await readUserBilling(user.id)).toMatchObject({
			stripe_customer_id: 'cus_original',
			stripe_plan: 'pro',
		})
		vi.unstubAllGlobals()
	}
})
