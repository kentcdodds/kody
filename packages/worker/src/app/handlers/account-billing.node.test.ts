import { expect, test, vi } from 'vitest'
import type * as StripeClient from '#worker/billing/stripe-client.ts'
import { StripeApiError } from '#worker/billing/stripe-client.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	createAccountBillingCancellationFeedbackApiHandler,
	createAccountBillingCheckoutApiHandler,
	createAccountBillingSuccessHandler,
} from './account-billing.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
	requireAuthenticatedPageUser: vi.fn<() => Promise<unknown>>(),
	userHasMcpOAuthGrants: vi.fn<() => Promise<boolean>>(),
	linkStripeCustomerFromCheckoutSessionAttribution:
		vi.fn<(...args: Array<unknown>) => Promise<unknown>>(),
	createCheckoutSession:
		vi.fn<(...args: Array<unknown>) => Promise<{ id: string; url: string }>>(),
	createBillingPortalSession:
		vi.fn<(...args: Array<unknown>) => Promise<{ url: string }>>(),
	listSubscriptions:
		vi.fn<(...args: Array<unknown>) => Promise<Array<unknown>>>(),
	renderAppPage: vi.fn(async ({ loaderData }: { loaderData?: unknown }) =>
		Response.json({ ok: true, loaderData }),
	),
	submitPlatformFeedback:
		vi.fn<(...args: Array<unknown>) => Promise<{ id: string }>>(),
	enqueuePlatformFeedbackDispatch:
		vi.fn<(...args: Array<unknown>) => Promise<void>>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/onboarding-data.ts', () => ({
	userHasMcpOAuthGrants: (...args: Array<unknown>) =>
		mockModule.userHasMcpOAuthGrants(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) =>
		mockModule.renderAppPage(...(args as [never])),
}))

vi.mock('#worker/billing/subscription-sync.ts', () => ({
	BillingLinkError: class BillingLinkError extends Error {
		readonly code: string
		constructor(code: string, message: string) {
			super(message)
			this.name = 'BillingLinkError'
			this.code = code
		}
	},
	linkStripeCustomerFromCheckoutSessionAttribution: (...args: Array<unknown>) =>
		mockModule.linkStripeCustomerFromCheckoutSessionAttribution(...args),
}))

vi.mock('#worker/platform-feedback/service.ts', () => ({
	submitPlatformFeedback: (...args: Array<unknown>) =>
		mockModule.submitPlatformFeedback(...args),
}))

vi.mock('#worker/platform-feedback/dispatch-queue-producer.ts', () => ({
	enqueuePlatformFeedbackDispatch: (...args: Array<unknown>) =>
		mockModule.enqueuePlatformFeedbackDispatch(...args),
}))

vi.mock('#worker/billing/stripe-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof StripeClient>()
	return {
		...actual,
		createCheckoutSession: (...args: Array<unknown>) =>
			mockModule.createCheckoutSession(...args),
		createBillingPortalSession: (...args: Array<unknown>) =>
			mockModule.createBillingPortalSession(...args),
		listSubscriptions: (...args: Array<unknown>) =>
			mockModule.listSubscriptions(...args),
	}
})

const authenticatedUser = {
	userId: 9,
	username: 'ada',
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

function createEnv(overrides: Record<string, unknown> = {}) {
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
		mode: 'checkout',
	})
	// No linked customer: nothing to look up in Stripe before Checkout.
	expect(mockModule.listSubscriptions).not.toHaveBeenCalled()
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

function subscription(input: { id: string; status: string; priceId: string }) {
	return {
		id: input.id,
		status: input.status,
		cancel_at: null,
		items: { data: [{ price: { id: input.priceId } }] },
	}
}

test('billing checkout routes existing subscribers through the portal update flow', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(authenticatedUser)
	mockModule.createCheckoutSession.mockReset()
	mockModule.createCheckoutSession.mockResolvedValue({
		id: 'cs_test',
		url: 'https://checkout.stripe.com/c/pay/cs_test',
	})
	mockModule.createBillingPortalSession.mockReset()
	mockModule.createBillingPortalSession.mockResolvedValue({
		url: 'https://billing.stripe.com/p/session/test',
	})
	mockModule.listSubscriptions.mockReset()

	// Linked customer whose subscriptions are all canceled: plain Checkout.
	mockModule.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_old',
			status: 'canceled',
			priceId: 'price_standard',
		}),
	])
	const env = createEnv({
		APP_DB: createBillingDb('cus_existing'),
		STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_kody',
	})
	const resubscribe = await postCheckout(env, { plan: 'standard' })
	expect(resubscribe.status).toBe(200)
	expect(await resubscribe.json()).toEqual({
		ok: true,
		url: 'https://checkout.stripe.com/c/pay/cs_test',
		mode: 'checkout',
	})
	expect(mockModule.listSubscriptions).toHaveBeenCalledWith(env, 'cus_existing')
	expect(mockModule.createCheckoutSession).toHaveBeenLastCalledWith(
		env,
		expect.objectContaining({
			priceId: 'price_standard',
			customerId: 'cus_existing',
		}),
	)
	expect(mockModule.createBillingPortalSession).not.toHaveBeenCalled()

	// Active Standard asking for Pro: portal subscription_update, no Checkout.
	mockModule.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'active',
			priceId: 'price_standard',
		}),
	])
	const upgrade = await postCheckout(env, { plan: 'pro', interval: 'year' })
	expect(upgrade.status).toBe(200)
	expect(await upgrade.json()).toEqual({
		ok: true,
		url: 'https://billing.stripe.com/p/session/test',
		mode: 'portal_update',
	})
	expect(mockModule.createBillingPortalSession).toHaveBeenCalledTimes(1)
	expect(mockModule.createBillingPortalSession).toHaveBeenLastCalledWith(env, {
		customerId: 'cus_existing',
		returnUrl: 'https://example.com/account/billing',
		configuration: 'bpc_kody',
		flowData: {
			type: 'subscription_update',
			subscriptionId: 'sub_standard',
			afterCompletionRedirectUrl:
				'https://example.com/account/billing?billing=updated',
		},
	})
	expect(mockModule.createCheckoutSession).toHaveBeenCalledTimes(1)

	// past_due keeps the plan, so it is still a switch rather than a new sub.
	mockModule.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'past_due',
			priceId: 'price_standard',
		}),
	])
	const pastDueSwitch = await postCheckout(env, { plan: 'pro' })
	expect(pastDueSwitch.status).toBe(200)
	expect(await pastDueSwitch.json()).toMatchObject({ mode: 'portal_update' })

	// Same price as the current subscription: nothing to change.
	mockModule.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'active',
			priceId: 'price_standard',
		}),
	])
	const samePlan = await postCheckout(env, {
		plan: 'standard',
		interval: 'month',
	})
	expect(samePlan.status).toBe(409)
	expect(await samePlan.json()).toEqual({
		ok: false,
		error: 'You are already on that plan.',
	})
	expect(mockModule.createBillingPortalSession).toHaveBeenCalledTimes(2)
	expect(mockModule.createCheckoutSession).toHaveBeenCalledTimes(1)

	// Legacy double subscriptions: plain portal (no flow) so the customer can
	// pick which one to keep.
	mockModule.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'active',
			priceId: 'price_standard',
		}),
		subscription({ id: 'sub_pro', status: 'trialing', priceId: 'price_pro' }),
	])
	const doubled = await postCheckout(env, { plan: 'pro', interval: 'year' })
	expect(doubled.status).toBe(200)
	expect(await doubled.json()).toEqual({
		ok: true,
		url: 'https://billing.stripe.com/p/session/test',
		mode: 'portal',
	})
	expect(mockModule.createBillingPortalSession).toHaveBeenLastCalledWith(env, {
		customerId: 'cus_existing',
		returnUrl: 'https://example.com/account/billing',
		configuration: 'bpc_kody',
	})
	expect(mockModule.createCheckoutSession).toHaveBeenCalledTimes(1)

	// Without a portal configuration id the account default applies.
	mockModule.listSubscriptions.mockResolvedValueOnce([
		subscription({
			id: 'sub_standard',
			status: 'active',
			priceId: 'price_standard',
		}),
	])
	const defaultConfigEnv = createEnv({
		APP_DB: createBillingDb('cus_existing'),
	})
	const defaultConfig = await postCheckout(defaultConfigEnv, { plan: 'pro' })
	expect(defaultConfig.status).toBe(200)
	expect(mockModule.createBillingPortalSession).toHaveBeenLastCalledWith(
		defaultConfigEnv,
		expect.objectContaining({ configuration: null }),
	)

	// Stripe failures while listing subscriptions map to the same 502 as a
	// failed Checkout Session so the UI shows one retry message.
	consoleError.mockImplementation(() => {})
	try {
		mockModule.listSubscriptions.mockRejectedValueOnce(
			new StripeApiError('Stripe API request failed with HTTP 503.', {
				status: 503,
			}),
		)
		const stripeDown = await postCheckout(env, { plan: 'pro' })
		expect(stripeDown.status).toBe(502)
		expect(await stripeDown.json()).toEqual({
			ok: false,
			error: 'Unable to start checkout. Try again shortly.',
		})
	} finally {
		consoleError.mockReset()
	}
})

async function postCancellationFeedback(env: Env, body: unknown) {
	const handler = createAccountBillingCancellationFeedbackApiHandler(env)
	return handler.handler({
		request: new Request(
			'https://example.com/account/billing/cancellation-feedback.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		),
		params: {},
		url: new URL(
			'https://example.com/account/billing/cancellation-feedback.json',
		),
	} as never)
}

test('billing cancellation feedback records platform feedback', async () => {
	mockModule.submitPlatformFeedback.mockResolvedValue({ id: 'fb_1' })
	mockModule.enqueuePlatformFeedbackDispatch.mockResolvedValue(undefined)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await postCancellationFeedback(createEnv(), {
		details: 'Too expensive.',
	})
	expect(unauthorized.status).toBe(401)
	expect(mockModule.submitPlatformFeedback).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue(authenticatedUser)
	const missingDetails = await postCancellationFeedback(createEnv(), {
		details: '   ',
	})
	expect(missingDetails.status).toBe(400)
	expect(mockModule.submitPlatformFeedback).not.toHaveBeenCalled()

	const env = createEnv()
	const success = await postCancellationFeedback(env, {
		details: 'Too expensive for my usage.',
	})
	expect(success.status).toBe(200)
	expect(await success.json()).toEqual({ ok: true })
	expect(mockModule.submitPlatformFeedback).toHaveBeenCalledWith(
		expect.objectContaining({
			submitterUserId: 'stable-ada',
			submitterUsername: 'ada',
			submitterEmail: 'ada@example.com',
			category: 'cancellation',
			details: 'Too expensive for my usage.',
		}),
	)
	expect(mockModule.enqueuePlatformFeedbackDispatch).toHaveBeenCalledWith(
		expect.objectContaining({ feedbackId: 'fb_1' }),
	)
})

test('billing success renders a thank-you page instead of redirecting', async () => {
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		...authenticatedUser,
		emailVerified: true,
	})
	mockModule.userHasMcpOAuthGrants.mockResolvedValue(false)
	mockModule.linkStripeCustomerFromCheckoutSessionAttribution.mockResolvedValue(
		{},
	)

	const handler = createAccountBillingSuccessHandler(createEnv())
	const missingSession = await handler.handler({
		request: new Request('https://example.com/account/billing/success'),
		params: {},
		url: new URL('https://example.com/account/billing/success'),
	} as never)
	expect(missingSession.status).toBe(302)
	expect(missingSession.headers.get('location')).toContain(
		'/account/billing?error=missing_session',
	)

	const success = await handler.handler({
		request: new Request(
			'https://example.com/account/billing/success?session_id=cs_test',
		),
		params: {},
		url: new URL(
			'https://example.com/account/billing/success?session_id=cs_test',
		),
	} as never)
	expect(success.status).toBe(200)
	expect(await success.json()).toEqual({
		ok: true,
		loaderData: {
			accountBillingSuccess: {
				ok: true,
				needsOnboarding: true,
			},
		},
	})
	expect(success.headers.get('location')).toBeNull()
})
