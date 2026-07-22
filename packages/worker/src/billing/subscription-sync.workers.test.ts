import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createBillingLinkReference } from './billing-config.ts'
import {
	BillingLinkError,
	linkStripeCustomerFromCheckoutSession,
	refreshStaleStripePlans,
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
	expect(result).toEqual({ stripePlan: 'pro', cancelAt: null })

	const row = await readUserBilling(user.id)
	expect(row).toEqual({
		stripe_customer_id: 'cus_happy',
		stripe_plan: 'pro',
		stripe_plan_refreshed_at: now.toISOString(),
	})

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

test('refreshStaleStripePlans refreshes stale linked customers', async () => {
	const email = `stale-refresh-${crypto.randomUUID()}@example.com`
	const staleAt = '2026-07-19T10:00:00.000Z'
	const now = new Date('2026-07-19T12:00:00.000Z')
	const user = await seedUser({
		email,
		stripeCustomerId: 'cus_stale',
		stripePlan: 'pro',
		stripePlanRefreshedAt: staleAt,
	})
	stubStripeFetch({
		subscriptions: {
			data: [
				{
					id: 'sub_stale',
					status: 'active',
					cancel_at: null,
					items: { data: [{ price: { id: 'price_pro' } }] },
				},
			],
		},
	})

	const result = await refreshStaleStripePlans({
		env: createBillingEnv(),
		now,
	})
	expect(result.skipped).toBe(false)
	expect(result.refreshed).toBeGreaterThanOrEqual(1)
	expect(result.failed).toBe(0)

	const row = await readUserBilling(user.id)
	expect(row).toEqual({
		stripe_customer_id: 'cus_stale',
		stripe_plan: 'pro',
		stripe_plan_refreshed_at: now.toISOString(),
	})

	vi.unstubAllGlobals()
})

test('refreshStaleStripePlans skips when billing is not configured', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	const fetchStub = vi.fn()
	vi.stubGlobal('fetch', fetchStub)

	const result = await refreshStaleStripePlans({
		env: createBillingEnv({ STRIPE_SECRET_KEY: '' }),
	})
	expect(result).toEqual({ refreshed: 0, failed: 0, skipped: true })
	expect(fetchStub).not.toHaveBeenCalled()

	vi.unstubAllGlobals()
})
