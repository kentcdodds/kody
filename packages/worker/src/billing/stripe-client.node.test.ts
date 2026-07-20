import { afterEach, expect, test, vi } from 'vitest'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import {
	BillingNotConfiguredError,
	createBillingPortalSession,
	getCheckoutSession,
	listSubscriptions,
	StripeApiError,
} from './stripe-client.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

test('getCheckoutSession sends Bearer auth and returns a parsed session', async () => {
	const fetchStub = vi.fn(async () =>
		jsonResponse({
			id: 'cs_test_1',
			customer: 'cus_123',
			client_reference_id: 'user-stable-id',
		}),
	)
	vi.stubGlobal('fetch', fetchStub)

	const session = await getCheckoutSession(
		{ STRIPE_SECRET_KEY: 'sk_test_secret' },
		'cs_test_1',
	)
	expect(session).toEqual({
		id: 'cs_test_1',
		customer: 'cus_123',
		client_reference_id: 'user-stable-id',
	})
	expect(fetchStub).toHaveBeenCalledOnce()
	const [url, init] = fetchStub.mock.calls[0]!
	expect(url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_1')
	expect(init).toMatchObject({
		method: 'GET',
		headers: expect.objectContaining({
			authorization: 'Bearer sk_test_secret',
			accept: 'application/json',
		}),
	})
})

test('listSubscriptions respects STRIPE_API_BASE_URL and status=all query', async () => {
	const fetchStub = vi.fn(async () =>
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
	vi.stubGlobal('fetch', fetchStub)

	const subscriptions = await listSubscriptions(
		{
			STRIPE_SECRET_KEY: 'sk_test_secret',
			STRIPE_API_BASE_URL: 'https://stripe.mock/',
		},
		'cus_abc',
	)
	expect(subscriptions).toHaveLength(1)
	expect(subscriptions[0]?.id).toBe('sub_1')

	const [url, init] = fetchStub.mock.calls[0]!
	const parsed = new URL(String(url))
	expect(parsed.origin).toBe('https://stripe.mock')
	expect(parsed.pathname).toBe('/v1/subscriptions')
	expect(parsed.searchParams.get('customer')).toBe('cus_abc')
	expect(parsed.searchParams.get('status')).toBe('all')
	expect(parsed.searchParams.get('limit')).toBe('100')
	expect(init).toMatchObject({
		method: 'GET',
		headers: expect.objectContaining({
			authorization: 'Bearer sk_test_secret',
		}),
	})
})

test('createBillingPortalSession posts form-encoded customer and return_url', async () => {
	const fetchStub = vi.fn(async () =>
		jsonResponse({ url: 'https://billing.stripe.com/session/test' }),
	)
	vi.stubGlobal('fetch', fetchStub)

	const result = await createBillingPortalSession(
		{ STRIPE_SECRET_KEY: 'sk_test_secret' },
		{
			customerId: 'cus_portal',
			returnUrl: 'https://app.example.com/account',
		},
	)
	expect(result).toEqual({ url: 'https://billing.stripe.com/session/test' })

	const [url, init] = fetchStub.mock.calls[0]!
	expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions')
	expect(init?.method).toBe('POST')
	expect(init?.headers).toMatchObject({
		authorization: 'Bearer sk_test_secret',
		'content-type': 'application/x-www-form-urlencoded',
	})
	const body = new URLSearchParams(String(init?.body))
	expect(body.get('customer')).toBe('cus_portal')
	expect(body.get('return_url')).toBe('https://app.example.com/account')
})

test('stripe client throws BillingNotConfiguredError without STRIPE_SECRET_KEY', async () => {
	await expect(getCheckoutSession({}, 'cs_test')).rejects.toBeInstanceOf(
		BillingNotConfiguredError,
	)
	await expect(listSubscriptions({}, 'cus_1')).rejects.toBeInstanceOf(
		BillingNotConfiguredError,
	)
	await expect(
		createBillingPortalSession(
			{ STRIPE_SECRET_KEY: '   ' },
			{ customerId: 'cus_1', returnUrl: 'https://example.com' },
		),
	).rejects.toBeInstanceOf(BillingNotConfiguredError)
})

test('stripe client wraps non-OK responses as StripeApiError with status', async () => {
	silenceExpectedConsoleErrors(['stripe_api_error'])
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ error: { message: 'nope' } }, 404)),
	)
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
	expect(error.message).toContain('404')
})

test('stripe client throws StripeApiError 502 on schema-mismatched bodies', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ id: 123, unexpected: true })),
	)
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
	expect(checkoutError.message).toContain('checkout session')

	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ data: 'not-an-array' })),
	)
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

	vi.stubGlobal(
		'fetch',
		vi.fn(async () => jsonResponse({ not_url: true })),
	)
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
})

test('getCheckoutSession rejects an empty session id before calling fetch', async () => {
	const fetchStub = vi.fn()
	vi.stubGlobal('fetch', fetchStub)
	const error = await getCheckoutSession(
		{ STRIPE_SECRET_KEY: 'sk_test_secret' },
		'   ',
	).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof StripeApiError)) {
		throw new Error('Expected StripeApiError')
	}
	expect(error.status).toBe(400)
	expect(fetchStub).not.toHaveBeenCalled()
})
