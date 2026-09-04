import { expect, test, vi } from 'vitest'
import {
	consoleError,
	silenceExpectedConsoleErrors,
} from '#worker/test-support/console-spies.ts'
import {
	accountDeletionCreditNoteMemo,
	BillingNotConfiguredError,
	cancelSubscription,
	createBillingPortalSession,
	createCheckoutSession,
	createProratedRefundCreditNote,
	deleteCustomer,
	getCheckoutSession,
	getLatestPaidInvoiceForSubscription,
	isAccountDeletionCreditNote,
	isStripeNothingToRefundError,
	listCreditNotesForInvoice,
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
		expect(body.get('automatic_tax[enabled]')).toBe('true')
		expect(body.get('tax_id_collection[enabled]')).toBe('true')
		expect(body.get('allow_promotion_codes')).toBe('true')
		expect(body.get('customer_update[address]')).toBeNull()
		expect(body.get('customer_update[name]')).toBeNull()
	} finally {
		vi.unstubAllGlobals()
	}

	// Existing Stripe customers must send customer, never customer_email.
	const customerIdFetch = vi.fn(async () =>
		jsonResponse({
			id: 'cs_new_2',
			url: 'https://checkout.stripe.com/c/pay/cs_new_2',
		}),
	)
	vi.stubGlobal('fetch', customerIdFetch)
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
			String(customerIdFetch.mock.calls[0]?.[1]?.body),
		)
		expect(body.get('customer')).toBe('cus_existing')
		expect(body.get('customer_email')).toBeNull()
		expect(body.get('customer_update[address]')).toBe('auto')
		expect(body.get('customer_update[name]')).toBe('auto')
		expect(body.get('automatic_tax[enabled]')).toBe('true')
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

test('stripe client immediately cancels subscriptions and deletes customers', async () => {
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse({ id: 'sub_active', status: 'canceled' }),
		)
		.mockResolvedValueOnce(jsonResponse({ id: 'cus_delete', deleted: true }))
	vi.stubGlobal('fetch', fetchMock)
	try {
		const env = { STRIPE_SECRET_KEY: 'sk_test_secret' }
		await cancelSubscription(env, 'sub_active')
		await deleteCustomer(env, 'cus_delete')

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(fetchMock.mock.calls[0]).toEqual([
			'https://api.stripe.com/v1/subscriptions/sub_active',
			expect.objectContaining({ method: 'DELETE' }),
		])
		expect(fetchMock.mock.calls[1]).toEqual([
			'https://api.stripe.com/v1/customers/cus_delete',
			expect.objectContaining({ method: 'DELETE' }),
		])

		consoleError.mockImplementation(() => {})
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
		await expect(
			deleteCustomer(env, 'cus_sensitive_identifier'),
		).rejects.toBeInstanceOf(StripeApiError)
		expect(consoleError).toHaveBeenCalledWith('stripe_api_error', {
			status: 503,
			path: '/v1/customers/<redacted>',
		})
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
			'cus_sensitive_identifier',
		)

		// Canceling a subscription Stripe no longer knows is idempotent success;
		// any other API failure still surfaces with its Stripe error code.
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				{
					error: {
						code: 'resource_missing',
						message: 'No such subscription: sub_gone',
					},
				},
				404,
			),
		)
		await expect(cancelSubscription(env, 'sub_gone')).resolves.toBeUndefined()
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				{ error: { code: 'rate_limit', message: 'Too many requests' } },
				429,
			),
		)
		await expect(cancelSubscription(env, 'sub_busy')).rejects.toMatchObject({
			name: 'StripeApiError',
			status: 429,
			code: 'rate_limit',
		})
	} finally {
		vi.unstubAllGlobals()
		consoleError.mockReset()
	}
})

test('stripe client reads the latest paid invoice and its credit notes for a subscription', async () => {
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse({
				object: 'list',
				data: [
					{
						id: 'in_latest',
						object: 'invoice',
						amount_paid: 1200,
						amount_due: 1200,
						currency: 'usd',
						lines: {
							object: 'list',
							data: [
								{
									id: 'il_latest',
									object: 'line_item',
									amount: 1200,
									description: 'Pro (monthly)',
									period: { start: 1_756_684_800, end: 1_759_276_800 },
								},
							],
						},
					},
				],
			}),
		)
		.mockResolvedValueOnce(jsonResponse({ object: 'list', data: [] }))
		.mockResolvedValueOnce(
			jsonResponse({
				object: 'list',
				data: [
					{
						id: 'cn_kody',
						object: 'credit_note',
						total: 600,
						currency: 'usd',
						status: 'issued',
						memo: accountDeletionCreditNoteMemo,
						metadata: { kody_account_deletion: '1' },
					},
				],
			}),
		)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const env = { STRIPE_SECRET_KEY: 'sk_test_secret' }
		const invoice = await getLatestPaidInvoiceForSubscription(env, 'sub_paid')
		expect(invoice).toEqual({
			id: 'in_latest',
			amount_paid: 1200,
			currency: 'usd',
			lines: {
				data: [
					{
						id: 'il_latest',
						amount: 1200,
						period: { start: 1_756_684_800, end: 1_759_276_800 },
					},
				],
			},
		})
		expect(fetchMock.mock.calls[0]).toEqual([
			'https://api.stripe.com/v1/invoices?subscription=sub_paid&status=paid&limit=1',
			expect.objectContaining({ method: 'GET' }),
		])

		// A trial that has not converted has no paid invoice at all.
		await expect(
			getLatestPaidInvoiceForSubscription(env, 'sub_trial'),
		).resolves.toBeNull()

		const creditNotes = await listCreditNotesForInvoice(env, 'in_latest')
		expect(creditNotes).toEqual([
			{
				id: 'cn_kody',
				total: 600,
				currency: 'usd',
				status: 'issued',
				memo: accountDeletionCreditNoteMemo,
				metadata: { kody_account_deletion: '1' },
			},
		])
		expect(fetchMock.mock.calls[2]).toEqual([
			'https://api.stripe.com/v1/credit_notes?invoice=in_latest&limit=100',
			expect.objectContaining({ method: 'GET' }),
		])
		expect(creditNotes.every(isAccountDeletionCreditNote)).toBe(true)
		expect(
			isAccountDeletionCreditNote({
				id: 'cn_void',
				total: 600,
				currency: 'usd',
				status: 'void',
				memo: accountDeletionCreditNoteMemo,
				metadata: { kody_account_deletion: '1' },
			}),
		).toBe(false)
		expect(
			isAccountDeletionCreditNote({
				id: 'cn_manual',
				total: 100,
				currency: 'usd',
				status: 'issued',
				memo: 'Goodwill',
			}),
		).toBe(false)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('stripe client previews then issues a prorated credit note that refunds the previewed total', async () => {
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse({
				object: 'credit_note',
				id: null,
				total: 654,
				currency: 'usd',
				status: 'issued',
				memo: null,
			}),
		)
		.mockResolvedValueOnce(
			jsonResponse({
				id: 'cn_created',
				object: 'credit_note',
				total: 654,
				currency: 'usd',
				status: 'issued',
				memo: accountDeletionCreditNoteMemo,
				metadata: { kody_account_deletion: '1' },
			}),
		)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const env = { STRIPE_SECRET_KEY: 'sk_test_secret' }
		const creditNote = await createProratedRefundCreditNote(env, {
			invoiceId: 'in_latest',
			invoiceLineItemId: 'il_latest',
			amount: 600,
			reason: 'order_change',
		})
		expect(creditNote).toEqual({
			id: 'cn_created',
			total: 654,
			currency: 'usd',
		})

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const [previewUrl, previewInit] = fetchMock.mock.calls[0]!
		expect(previewInit).toMatchObject({ method: 'GET' })
		expect(
			Object.fromEntries(new URL(previewUrl as string).searchParams),
		).toEqual({
			invoice: 'in_latest',
			'lines[0][type]': 'invoice_line_item',
			'lines[0][invoice_line_item]': 'il_latest',
			'lines[0][amount]': '600',
		})
		expect(new URL(previewUrl as string).pathname).toBe(
			'/v1/credit_notes/preview',
		)

		const [createUrl, createInit] = fetchMock.mock.calls[1]!
		expect(createUrl).toBe('https://api.stripe.com/v1/credit_notes')
		expect(createInit).toMatchObject({
			method: 'POST',
			headers: expect.objectContaining({
				'content-type': 'application/x-www-form-urlencoded',
			}),
		})
		// The refund must equal the credit note total (line share plus its tax),
		// which only the preview knows; the tax-exclusive line amount is what
		// Stripe prorates tax from.
		expect(
			Object.fromEntries(
				new URLSearchParams((createInit as RequestInit).body as string),
			),
		).toEqual({
			invoice: 'in_latest',
			'lines[0][type]': 'invoice_line_item',
			'lines[0][invoice_line_item]': 'il_latest',
			'lines[0][amount]': '600',
			refund_amount: '654',
			reason: 'order_change',
			memo: accountDeletionCreditNoteMemo,
			'metadata[kody_account_deletion]': '1',
		})

		// Guard rails that never reach Stripe.
		fetchMock.mockClear()
		await expect(
			createProratedRefundCreditNote(env, {
				invoiceId: 'in_latest',
				invoiceLineItemId: 'il_latest',
				amount: 0,
				reason: 'order_change',
			}),
		).rejects.toMatchObject({ name: 'StripeApiError', status: 400 })
		await expect(
			createProratedRefundCreditNote(env, {
				invoiceId: ' ',
				invoiceLineItemId: 'il_latest',
				amount: 600,
				reason: 'order_change',
			}),
		).rejects.toMatchObject({ name: 'StripeApiError', status: 400 })
		expect(fetchMock).not.toHaveBeenCalled()

		// Stripe's "nothing left to credit" validation comes back as a bare 400
		// with only a message; it must be classifiable without leaking that
		// message (which can embed ids) into logs.
		consoleError.mockImplementation(() => {})
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				{
					error: {
						type: 'invalid_request_error',
						message:
							'The credit note amount exceeds the remaining creditable amount of in_latest.',
					},
				},
				400,
			),
		)
		const exhausted = await createProratedRefundCreditNote(env, {
			invoiceId: 'in_latest',
			invoiceLineItemId: 'il_latest',
			amount: 600,
			reason: 'order_change',
		}).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		expect(exhausted).toBeInstanceOf(StripeApiError)
		expect(isStripeNothingToRefundError(exhausted)).toBe(true)
		expect(consoleError).toHaveBeenCalledWith('stripe_api_error', {
			status: 400,
			path: '/v1/credit_notes/preview',
		})
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain('in_latest')

		expect(
			isStripeNothingToRefundError(
				new StripeApiError('Stripe API request failed with HTTP 400.', {
					status: 400,
					code: 'charge_already_refunded',
				}),
			),
		).toBe(true)
		expect(
			isStripeNothingToRefundError(
				new StripeApiError('Stripe API request failed with HTTP 400.', {
					status: 400,
					stripeMessage: 'Invalid integer: abc',
				}),
			),
		).toBe(false)
		expect(
			isStripeNothingToRefundError(
				new StripeApiError('Stripe API request failed with HTTP 503.', {
					status: 503,
					stripeMessage: 'exceeds',
				}),
			),
		).toBe(false)
		expect(isStripeNothingToRefundError(new Error('exceeds'))).toBe(false)
	} finally {
		vi.unstubAllGlobals()
		consoleError.mockReset()
	}
})

test('stripe client rejects missing config and maps API failure shapes', async () => {
	await expect(getCheckoutSession({}, 'cs_test')).rejects.toBeInstanceOf(
		BillingNotConfiguredError,
	)

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
