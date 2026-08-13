import { expect, test, vi } from 'vitest'
import type * as StripeClient from '#worker/billing/stripe-client.ts'
import { createAccountBillingCheckoutApiHandler } from './account-billing.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
	createCheckoutSession:
		vi.fn<(...args: Array<unknown>) => Promise<{ id: string; url: string }>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/billing/stripe-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StripeClient>()
	return {
		...actual,
		createCheckoutSession: (...args: Array<unknown>) =>
			mockModule.createCheckoutSession(...args),
	}
})

const authenticatedUser = {
	userId: 9,
	email: 'ada@example.com',
	mcpUser: { userId: 'stable-ada' },
}

function createBillingDb(customerId: string | null = null) {
	return {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							return { stripe_customer_id: customerId }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createEnv(overrides: Record<string, string> = {}) {
	return {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_STANDARD_PRICE_ID: 'price_standard',
		STRIPE_STANDARD_YEARLY_PRICE_ID: 'price_standard_yearly',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
		APP_DB: createBillingDb(),
		...overrides,
	} as unknown as Env
}

async function postCheckout(env: Env, body: unknown, method: string = 'POST') {
	const handler = createAccountBillingCheckoutApiHandler(env)
	return handler.handler({
		request: new Request('https://example.com/account/billing/checkout.json', {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: method === 'POST' ? JSON.stringify(body) : undefined,
		}),
		params: {},
		url: new URL('https://example.com/account/billing/checkout.json'),
	} as never)
}

test('billing checkout selects monthly vs yearly Stripe price ids', async () => {
	mockModule.createCheckoutSession.mockResolvedValue({
		id: 'cs_test',
		url: 'https://checkout.stripe.com/c/pay/cs_test',
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await postCheckout(createEnv(), { plan: 'standard' })
	expect(unauthorized.status).toBe(401)
	expect(mockModule.createCheckoutSession).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue(authenticatedUser)
	const missingPlan = await postCheckout(createEnv(), {})
	expect(missingPlan.status).toBe(400)
	expect(await missingPlan.json()).toMatchObject({ ok: false })

	const invalidInterval = await postCheckout(createEnv(), {
		plan: 'standard',
		interval: 'week',
	})
	expect(invalidInterval.status).toBe(400)
	expect(await invalidInterval.json()).toMatchObject({ ok: false })

	const env = createEnv()
	const monthlyStandard = await postCheckout(env, { plan: 'standard' })
	expect(monthlyStandard.status).toBe(200)
	expect(await monthlyStandard.json()).toEqual({
		ok: true,
		url: 'https://checkout.stripe.com/c/pay/cs_test',
	})
	expect(mockModule.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({
			priceId: 'price_standard',
			customerEmail: 'ada@example.com',
		}),
	)

	const yearlyStandard = await postCheckout(env, {
		plan: 'standard',
		interval: 'year',
	})
	expect(yearlyStandard.status).toBe(200)
	expect(mockModule.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({ priceId: 'price_standard_yearly' }),
	)

	const monthlyPro = await postCheckout(env, {
		plan: 'pro',
		interval: 'month',
	})
	expect(monthlyPro.status).toBe(200)
	expect(mockModule.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({ priceId: 'price_pro' }),
	)

	const yearlyPro = await postCheckout(env, {
		plan: 'pro',
		interval: 'year',
	})
	expect(yearlyPro.status).toBe(200)
	expect(mockModule.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({ priceId: 'price_pro_yearly' }),
	)

	const yearlyMissing = await postCheckout(
		createEnv({ STRIPE_STANDARD_YEARLY_PRICE_ID: '' }),
		{ plan: 'standard', interval: 'year' },
	)
	expect(yearlyMissing.status).toBe(409)
	expect(mockModule.createCheckoutSession).toHaveBeenCalledTimes(4)
})
