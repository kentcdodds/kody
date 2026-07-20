import { expect, test, vi } from 'vitest'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import {
	BillingNotConfiguredError,
	createBillingPortalSession,
	createCheckoutSession,
	getCheckoutSession,
	listSubscriptions,
	StripeApiError,
} from './stripe-client.ts'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

test('stripe client request contracts for checkout, subscriptions, and portal', async () => {
	const checkoutFetch = vi.fn(async () =>
		jsonResponse({
			id: 'cs_test_1',
			customer: 'cus_123',
			client_reference_id: 'user-stable-id',
		}),
	)
	vi.stubGlobal('fetch', checkoutFetch)
	try {
		const session = await getCheckoutSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			'cs_test_1',
		)
		expect(session).toEqual({
			id: 'cs_test_1',
			customer: 'cus_123',
			client_reference_id: 'user-stable-id',
		})
		expect(checkoutFetch).toHaveBeenCalledOnce()
		const [checkoutUrl, checkoutInit] = checkoutFetch.mock.calls[0]!
		expect(checkoutUrl).toBe(
			'https://api.stripe.com/v1/checkout/sessions/cs_test_1',
		)
		expect(checkoutInit).toMatchObject({
			method: 'GET',
			headers: expect.objectContaining({
				authorization: 'Bearer sk_test_secret',
				accept: 'application/json',
			}),
		})
	} finally {
		vi.unstubAllGlobals()
	}

	const listFetch = vi.fn(async () =>
		jsonResponse({
			data: [
				{
					id: 'sub_1',
					status: 'active',
					cancel_at: null,
					items: { data: [{ price: { id: 'price_1' } }] },
				},
			],
		}),
	)
	vi.stubGlobal('fetch', listFetch)
	try {
		const subscriptions = await listSubscriptions(
			{
				STRIPE_SECRET_KEY: 'sk_test_secret',
				STRIPE_API_BASE_URL: 'https://stripe.mock/',
			},
			'cus_abc',
		)
		expect(subscriptions).toHaveLength(1)
		expect(subscriptions[0]?.id).toBe('sub_1')

		const [listUrl, listInit] = listFetch.mock.calls[0]!
		const parsed = new URL(String(listUrl))
		expect(parsed.origin).toBe('https://stripe.mock')
		expect(parsed.pathname).toBe('/v1/subscriptions')
		expect(parsed.searchParams.get('customer')).toBe('cus_abc')
		expect(parsed.searchParams.get('status')).toBe('all')
		expect(parsed.searchParams.get('limit')).toBe('100')
		expect(listInit).toMatchObject({
			method: 'GET',
			headers: expect.objectContaining({
				authorization: 'Bearer sk_test_secret',
			}),
		})
	} finally {
		vi.unstubAllGlobals()
	}

	const portalFetch = vi.fn(async () =>
		jsonResponse({ url: 'https://billing.stripe.com/session/test' }),
	)
	vi.stubGlobal('fetch', portalFetch)
	try {
		const result = await createBillingPortalSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			{
				customerId: 'cus_portal',
				returnUrl: 'https://app.example.com/account',
			},
		)
		expect(result).toEqual({
			url: 'https://billing.stripe.com/session/test',
		})

		const [portalUrl, portalInit] = portalFetch.mock.calls[0]!
		expect(portalUrl).toBe('https://api.stripe.com/v1/billing_portal/sessions')
		expect(portalInit?.method).toBe('POST')
		expect(portalInit?.headers).toMatchObject({
			authorization: 'Bearer sk_test_secret',
			'content-type': 'application/x-www-form-urlencoded',
		})
		const body = new URLSearchParams(String(portalInit?.body))
		expect(body.get('customer')).toBe('cus_portal')
		expect(body.get('return_url')).toBe('https://app.example.com/account')
	} finally {
		vi.unstubAllGlobals()
	}
})

test('createCheckoutSession posts subscription form fields and auth header', async () => {
	const createFetch = vi.fn(async () =>
		jsonResponse({
			id: 'cs_new_1',
			url: 'https://checkout.stripe.com/c/pay/cs_new_1',
		}),
	)
	vi.stubGlobal('fetch', createFetch)
	try {
		const result = await createCheckoutSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			{
				priceId: 'price_pro',
				clientReferenceId: 'signed-ref',
				successUrl:
					'https://app.example.com/account/billing/success?session_id={CHECKOUT_SESSION_ID}',
				cancelUrl: 'https://app.example.com/account/billing',
				customerEmail: 'user@example.com',
			},
		)
		expect(result).toEqual({
			id: 'cs_new_1',
			url: 'https://checkout.stripe.com/c/pay/cs_new_1',
		})

		expect(createFetch).toHaveBeenCalledOnce()
		const [createUrl, createInit] = createFetch.mock.calls[0]!
		expect(createUrl).toBe('https://api.stripe.com/v1/checkout/sessions')
		expect(createInit?.method).toBe('POST')
		expect(createInit?.headers).toMatchObject({
			authorization: 'Bearer sk_test_secret',
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'application/json',
		})
		const body = new URLSearchParams(String(createInit?.body))
		expect(body.get('mode')).toBe('subscription')
		expect(body.get('line_items[0][price]')).toBe('price_pro')
		expect(body.get('line_items[0][quantity]')).toBe('1')
		expect(body.get('client_reference_id')).toBe('signed-ref')
		expect(body.get('success_url')).toBe(
			'https://app.example.com/account/billing/success?session_id={CHECKOUT_SESSION_ID}',
		)
		expect(body.get('cancel_url')).toBe(
			'https://app.example.com/account/billing',
		)
		expect(body.get('customer_email')).toBe('user@example.com')
		expect(body.get('customer')).toBeNull()
	} finally {
		vi.unstubAllGlobals()
	}
})

test('createCheckoutSession uses customer when customerId is set, not customer_email', async () => {
	const createFetch = vi.fn(async () =>
		jsonResponse({
			id: 'cs_new_2',
			url: 'https://checkout.stripe.com/c/pay/cs_new_2',
		}),
	)
	vi.stubGlobal('fetch', createFetch)
	try {
		await createCheckoutSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			{
				priceId: 'price_pro',
				clientReferenceId: 'signed-ref',
				successUrl:
					'https://app.example.com/account/billing/success?session_id={CHECKOUT_SESSION_ID}',
				cancelUrl: 'https://app.example.com/account/billing',
				customerId: 'cus_existing',
				customerEmail: 'should-not-send@example.com',
			},
		)
		const body = new URLSearchParams(
			String(createFetch.mock.calls[0]?.[1]?.body),
		)
		expect(body.get('customer')).toBe('cus_existing')
		expect(body.get('customer_email')).toBeNull()
	} finally {
		vi.unstubAllGlobals()
	}
})

test('createCheckoutSession rejects null url and non-OK Stripe responses', async () => {
	silenceExpectedConsoleErrors(['stripe_api_error'])

	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ id: 'cs_null_url', url: null })),
	)
	try {
		const nullUrlError = await createCheckoutSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			{
				priceId: 'price_pro',
				clientReferenceId: 'signed-ref',
				successUrl:
					'https://app.example.com/account/billing/success?session_id={CHECKOUT_SESSION_ID}',
				cancelUrl: 'https://app.example.com/account/billing',
				customerEmail: 'user@example.com',
			},
		).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		if (!(nullUrlError instanceof StripeApiError)) {
			throw new Error('Expected StripeApiError for null checkout url')
		}
		expect(nullUrlError.status).toBe(502)
	} finally {
		vi.unstubAllGlobals()
	}

	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ error: { message: 'nope' } }, 402)),
	)
	try {
		const apiError = await createCheckoutSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			{
				priceId: 'price_pro',
				clientReferenceId: 'signed-ref',
				successUrl:
					'https://app.example.com/account/billing/success?session_id={CHECKOUT_SESSION_ID}',
				cancelUrl: 'https://app.example.com/account/billing',
				customerEmail: 'user@example.com',
			},
		).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		if (!(apiError instanceof StripeApiError)) {
			throw new Error('Expected StripeApiError for non-OK Stripe response')
		}
		expect(apiError.status).toBe(402)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('stripe client rejects missing config and maps API failure shapes', async () => {
	await expect(getCheckoutSession({}, 'cs_test')).rejects.toBeInstanceOf(
		BillingNotConfiguredError,
	)

	silenceExpectedConsoleErrors(['stripe_api_error'])
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ error: { message: 'nope' } }, 404)),
	)
	try {
		const error = await getCheckoutSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			'cs_missing',
		).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		if (!(error instanceof StripeApiError)) {
			throw new Error('Expected StripeApiError')
		}
		expect(error.status).toBe(404)
	} finally {
		vi.unstubAllGlobals()
	}

	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ id: 123, unexpected: true })),
	)
	try {
		const checkoutError = await getCheckoutSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			'cs_bad',
		).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		if (!(checkoutError instanceof StripeApiError)) {
			throw new Error('Expected StripeApiError for checkout session')
		}
		expect(checkoutError.status).toBe(502)
	} finally {
		vi.unstubAllGlobals()
	}

	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ data: 'not-an-array' })),
	)
	try {
		const listError = await listSubscriptions(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			'cus_1',
		).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		if (!(listError instanceof StripeApiError)) {
			throw new Error('Expected StripeApiError for subscriptions list')
		}
		expect(listError.status).toBe(502)
	} finally {
		vi.unstubAllGlobals()
	}

	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ not_url: true })),
	)
	try {
		const portalError = await createBillingPortalSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			{ customerId: 'cus_1', returnUrl: 'https://example.com' },
		).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		if (!(portalError instanceof StripeApiError)) {
			throw new Error('Expected StripeApiError for portal session')
		}
		expect(portalError.status).toBe(502)
	} finally {
		vi.unstubAllGlobals()
	}

	const fetchStub = vi.fn()
	vi.stubGlobal('fetch', fetchStub)
	try {
		const emptyIdError = await getCheckoutSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			'   ',
		).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		if (!(emptyIdError instanceof StripeApiError)) {
			throw new Error('Expected StripeApiError')
		}
		expect(emptyIdError.status).toBe(400)
		expect(fetchStub).not.toHaveBeenCalled()
	} finally {
		vi.unstubAllGlobals()
	}
})
