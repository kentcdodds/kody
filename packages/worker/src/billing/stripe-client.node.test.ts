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
	creditNoteCapFitAttempts,
	creditNoteListMaxPages,
	deleteCustomer,
	getCheckoutSession,
	isAccountDeletionCreditNote,
	isStripeNothingToRefundError,
	listCreditNotesForCustomer,
	listCreditNotesForInvoice,
	listPaidInvoicesForSubscription,
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
		// Plain portal: no configuration pin and no deep-link flow.
		expect(body.get('configuration')).toBeNull()
		expect(body.get('flow_data[type]')).toBeNull()
	} finally {
		vi.unstubAllGlobals()
	}

	// Plan changes for existing subscribers open the portal directly on the
	// subscription_update step with the Kody portal configuration.
	const portalFlowFetch = vi.fn(async () =>
		jsonResponse({ url: 'https://billing.stripe.com/session/flow' }),
	)
	vi.stubGlobal('fetch', portalFlowFetch)
	try {
		const result = await createBillingPortalSession(
			{ STRIPE_SECRET_KEY: 'sk_test_secret' },
			{
				customerId: 'cus_portal',
				returnUrl: 'https://app.example.com/account/billing',
				configuration: ' bpc_kody ',
				flowData: {
					type: 'subscription_update',
					subscriptionId: 'sub_current',
					afterCompletionRedirectUrl:
						'https://app.example.com/account/billing?billing=updated',
				},
			},
		)
		expect(result).toEqual({
			url: 'https://billing.stripe.com/session/flow',
		})
		const body = new URLSearchParams(
			String(portalFlowFetch.mock.calls[0]?.[1]?.body),
		)
		expect(body.get('customer')).toBe('cus_portal')
		expect(body.get('return_url')).toBe(
			'https://app.example.com/account/billing',
		)
		expect(body.get('configuration')).toBe('bpc_kody')
		expect(body.get('flow_data[type]')).toBe('subscription_update')
		expect(body.get('flow_data[subscription_update][subscription]')).toBe(
			'sub_current',
		)
		expect(body.get('flow_data[after_completion][type]')).toBe('redirect')
		expect(body.get('flow_data[after_completion][redirect][return_url]')).toBe(
			'https://app.example.com/account/billing?billing=updated',
		)
	} finally {
		vi.unstubAllGlobals()
	}

	const noFlowFetch = vi.fn()
	vi.stubGlobal('fetch', noFlowFetch)
	try {
		await expect(
			createBillingPortalSession(
				{ STRIPE_SECRET_KEY: 'sk_test_secret' },
				{
					customerId: 'cus_portal',
					returnUrl: 'https://app.example.com/account/billing',
					flowData: {
						type: 'subscription_update',
						subscriptionId: '   ',
						afterCompletionRedirectUrl: 'https://app.example.com/account',
					},
				},
			),
		).rejects.toMatchObject({ name: 'StripeApiError', status: 400 })
		expect(noFlowFetch).not.toHaveBeenCalled()
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

test('stripe client reads recent paid invoices and credit notes for a subscription and customer', async () => {
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse({
				object: 'list',
				data: [
					{
						id: 'in_latest',
						object: 'invoice',
						amount_paid: 600,
						amount_due: 600,
						currency: 'usd',
						lines: {
							object: 'list',
							data: [
								{
									id: 'il_latest',
									object: 'line_item',
									amount: 1200,
									description: 'Pro (monthly)',
									discount_amounts: [{ amount: 600, discount: 'di_promo' }],
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
				has_more: false,
				data: [
					{
						id: 'cn_kody',
						object: 'credit_note',
						invoice: 'in_latest',
						total: 300,
						currency: 'usd',
						status: 'issued',
						memo: accountDeletionCreditNoteMemo,
						metadata: {
							kody_account_deletion: '1',
							kody_subscription_id: 'sub_paid',
						},
					},
				],
			}),
		)
		.mockResolvedValueOnce(
			jsonResponse({ object: 'list', has_more: false, data: [] }),
		)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const env = { STRIPE_SECRET_KEY: 'sk_test_secret' }
		const invoices = await listPaidInvoicesForSubscription(env, 'sub_paid')
		// The gross line amount and its discounts are both visible; the
		// customer paid 600 for a 1200 line.
		expect(invoices).toEqual([
			{
				id: 'in_latest',
				amount_paid: 600,
				currency: 'usd',
				lines: {
					data: [
						{
							id: 'il_latest',
							amount: 1200,
							discount_amounts: [{ amount: 600 }],
							period: { start: 1_756_684_800, end: 1_759_276_800 },
						},
					],
				},
			},
		])
		expect(fetchMock.mock.calls[0]).toEqual([
			'https://api.stripe.com/v1/invoices?subscription=sub_paid&status=paid&limit=10',
			expect.objectContaining({ method: 'GET' }),
		])

		// A trial that has not converted has no paid invoice at all.
		await expect(
			listPaidInvoicesForSubscription(env, 'sub_trial'),
		).resolves.toEqual([])

		const creditNotes = await listCreditNotesForInvoice(env, 'in_latest')
		expect(creditNotes).toEqual([
			{
				id: 'cn_kody',
				invoice: 'in_latest',
				total: 300,
				currency: 'usd',
				status: 'issued',
				metadata: {
					kody_account_deletion: '1',
					kody_subscription_id: 'sub_paid',
				},
			},
		])
		expect(fetchMock.mock.calls[2]).toEqual([
			'https://api.stripe.com/v1/credit_notes?invoice=in_latest&limit=100',
			expect.objectContaining({ method: 'GET' }),
		])
		expect(creditNotes.every(isAccountDeletionCreditNote)).toBe(true)

		await expect(listCreditNotesForCustomer(env, 'cus_paid')).resolves.toEqual(
			[],
		)
		expect(fetchMock.mock.calls[3]).toEqual([
			'https://api.stripe.com/v1/credit_notes?customer=cus_paid&limit=100',
			expect.objectContaining({ method: 'GET' }),
		])

		// Only an issued note carrying the metadata marker is Kody's; the memo
		// alone proves nothing because support can reuse the same text.
		expect(
			isAccountDeletionCreditNote({
				id: 'cn_void',
				invoice: 'in_latest',
				total: 600,
				currency: 'usd',
				status: 'void',
				metadata: { kody_account_deletion: '1' },
			}),
		).toBe(false)
		expect(
			isAccountDeletionCreditNote({
				id: 'cn_memo_only',
				invoice: 'in_latest',
				total: 600,
				currency: 'usd',
				status: 'issued',
				metadata: {},
			}),
		).toBe(false)
	} finally {
		vi.unstubAllGlobals()
	}
})

function creditNoteFixture(id: string, invoice: string) {
	return {
		id,
		object: 'credit_note',
		invoice,
		total: 100,
		currency: 'usd',
		status: 'issued',
		metadata: {},
	}
}

function creditNotePage(input: {
	ids: Array<string>
	invoice: string
	hasMore: boolean
}) {
	return jsonResponse({
		object: 'list',
		has_more: input.hasMore,
		data: input.ids.map((id) => creditNoteFixture(id, input.invoice)),
	})
}

function queryOf(url: unknown) {
	return Object.fromEntries(new URL(url as string).searchParams)
}

test('stripe client follows credit note pagination to the end and refuses an endless listing', async () => {
	const env = { STRIPE_SECRET_KEY: 'sk_test_secret' }

	// Per invoice: three pages, each requested from the previous page's last
	// id, so an invoice with more than 100 credit notes is never under-counted
	// (that under-count would over-refund).
	let fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			creditNotePage({ ids: ['cn_1', 'cn_2'], invoice: 'in_1', hasMore: true }),
		)
		.mockResolvedValueOnce(
			creditNotePage({ ids: ['cn_3', 'cn_4'], invoice: 'in_1', hasMore: true }),
		)
		.mockResolvedValueOnce(
			creditNotePage({ ids: ['cn_5'], invoice: 'in_1', hasMore: false }),
		)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const forInvoice = await listCreditNotesForInvoice(env, 'in_1')
		expect(forInvoice.map((creditNote) => creditNote.id)).toEqual([
			'cn_1',
			'cn_2',
			'cn_3',
			'cn_4',
			'cn_5',
		])
		expect(fetchMock.mock.calls.map(([url]) => queryOf(url))).toEqual([
			{ invoice: 'in_1', limit: '100' },
			{ invoice: 'in_1', limit: '100', starting_after: 'cn_2' },
			{ invoice: 'in_1', limit: '100', starting_after: 'cn_4' },
		])

		// Per customer: same cursor walk, so the deletion report includes every
		// earlier Kody note, not just the first page.
		fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				creditNotePage({ ids: ['cn_a'], invoice: 'in_a', hasMore: true }),
			)
			.mockResolvedValueOnce(
				creditNotePage({ ids: ['cn_b'], invoice: 'in_b', hasMore: false }),
			)
		vi.stubGlobal('fetch', fetchMock)
		const forCustomer = await listCreditNotesForCustomer(env, 'cus_1')
		expect(forCustomer.map((creditNote) => creditNote.id)).toEqual([
			'cn_a',
			'cn_b',
		])
		expect(fetchMock.mock.calls.map(([url]) => queryOf(url))).toEqual([
			{ customer: 'cus_1', limit: '100' },
			{ customer: 'cus_1', limit: '100', starting_after: 'cn_a' },
		])

		// A listing still reporting has_more after the page cap is not trusted
		// as complete: the caller learns it is incomplete rather than getting a
		// partial sum it would treat as the whole.
		fetchMock = vi.fn(async (url: string) => {
			const page = Number(queryOf(url).starting_after?.slice(3) ?? 0) + 1
			return creditNotePage({
				ids: [`cn_${page}`],
				invoice: 'in_endless',
				hasMore: true,
			})
		})
		vi.stubGlobal('fetch', fetchMock)
		await expect(
			listCreditNotesForInvoice(env, 'in_endless'),
		).rejects.toMatchObject({
			name: 'StripeCreditNoteListIncompleteError',
			status: 502,
			pages: creditNoteListMaxPages,
		})
		expect(fetchMock).toHaveBeenCalledTimes(creditNoteListMaxPages)
		expect(queryOf(fetchMock.mock.calls.at(-1)![0])).toEqual({
			invoice: 'in_endless',
			limit: '100',
			starting_after: `cn_${creditNoteListMaxPages - 1}`,
		})

		// A list page without has_more is not a Stripe list.
		fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ object: 'list', data: [] }))
		vi.stubGlobal('fetch', fetchMock)
		await expect(
			listCreditNotesForCustomer(env, 'cus_1'),
		).rejects.toMatchObject({ name: 'StripeApiError', status: 502 })
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
				invoice: 'in_latest',
				total: 654,
				currency: 'usd',
				status: 'issued',
				memo: accountDeletionCreditNoteMemo,
				metadata: { kody_account_deletion: '1', kody_subscription_id: 'sub_1' },
			}),
		)
	vi.stubGlobal('fetch', fetchMock)
	try {
		const env = { STRIPE_SECRET_KEY: 'sk_test_secret' }
		const creditNote = await createProratedRefundCreditNote(env, {
			invoiceId: 'in_latest',
			subscriptionId: 'sub_1',
			lines: [
				{ invoiceLineItemId: 'il_plan', amount: 600 },
				{ invoiceLineItemId: 'il_addon', amount: 250 },
			],
			maxRefundMinor: 1500,
			reason: 'order_change',
		})
		expect(creditNote).toEqual({
			outcome: 'issued',
			id: 'cn_created',
			total: 654,
			currency: 'usd',
		})

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const [previewUrl, previewInit] = fetchMock.mock.calls[0]!
		expect(previewInit).toMatchObject({ method: 'GET' })
		const expectedLines = {
			invoice: 'in_latest',
			'lines[0][type]': 'invoice_line_item',
			'lines[0][invoice_line_item]': 'il_plan',
			'lines[0][amount]': '600',
			'lines[1][type]': 'invoice_line_item',
			'lines[1][invoice_line_item]': 'il_addon',
			'lines[1][amount]': '250',
		}
		expect(
			Object.fromEntries(new URL(previewUrl as string).searchParams),
		).toEqual(expectedLines)
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
		// The refund must equal the credit note total (line shares minus their
		// discounts plus their tax), which only the preview knows; the gross
		// line amounts are what Stripe prorates discounts and tax from.
		expect(
			Object.fromEntries(
				new URLSearchParams((createInit as RequestInit).body as string),
			),
		).toEqual({
			...expectedLines,
			refund_amount: '654',
			reason: 'order_change',
			memo: accountDeletionCreditNoteMemo,
			'metadata[kody_account_deletion]': '1',
			'metadata[kody_subscription_id]': 'sub_1',
		})

		// A preview that totals zero (a fully discounted line) creates nothing.
		fetchMock.mockClear()
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ object: 'credit_note', total: 0, currency: 'usd' }),
		)
		await expect(
			createProratedRefundCreditNote(env, {
				invoiceId: 'in_free',
				subscriptionId: 'sub_1',
				lines: [{ invoiceLineItemId: 'il_free', amount: 600 }],
				maxRefundMinor: 1200,
				reason: 'order_change',
			}),
		).resolves.toEqual({ outcome: 'nothing_to_refund' })
		expect(fetchMock).toHaveBeenCalledOnce()

		// Guard rails that never reach Stripe.
		fetchMock.mockClear()
		for (const input of [
			{
				invoiceId: 'in_latest',
				lines: [{ invoiceLineItemId: 'il_1', amount: 0 }],
			},
			{ invoiceId: ' ', lines: [{ invoiceLineItemId: 'il_1', amount: 600 }] },
			{
				invoiceId: 'in_latest',
				lines: [{ invoiceLineItemId: ' ', amount: 600 }],
			},
			{ invoiceId: 'in_latest', lines: [] },
			{
				invoiceId: 'in_latest',
				lines: [{ invoiceLineItemId: 'il_1', amount: 600 }],
				maxRefundMinor: 0,
			},
		]) {
			await expect(
				createProratedRefundCreditNote(env, {
					maxRefundMinor: 1200,
					...input,
					subscriptionId: 'sub_1',
					reason: 'order_change',
				}),
			).rejects.toMatchObject({ name: 'StripeApiError', status: 400 })
		}
		expect(fetchMock).not.toHaveBeenCalled()

		// Stripe's validation failures come back as a bare 400 with only a
		// message; they must be classifiable without leaking that message (which
		// can embed ids) into logs. Only an already-refunded charge counts as
		// "nothing to refund"; an amount mismatch is a real failure.
		consoleError.mockImplementation(() => {})
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				{
					error: {
						type: 'invalid_request_error',
						message:
							'The charge for in_latest has already been fully refunded.',
					},
				},
				400,
			),
		)
		const alreadyRefunded = await createProratedRefundCreditNote(env, {
			invoiceId: 'in_latest',
			subscriptionId: 'sub_1',
			lines: [{ invoiceLineItemId: 'il_plan', amount: 600 }],
			maxRefundMinor: 1200,
			reason: 'order_change',
		}).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		expect(alreadyRefunded).toBeInstanceOf(StripeApiError)
		expect(isStripeNothingToRefundError(alreadyRefunded)).toBe(true)
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
					stripeMessage:
						'The credit note amount exceeds the maximum creditable amount for this invoice.',
				}),
			),
		).toBe(false)
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
					stripeMessage: 'already refunded',
				}),
			),
		).toBe(false)
		expect(isStripeNothingToRefundError(new Error('already refunded'))).toBe(
			false,
		)
	} finally {
		vi.unstubAllGlobals()
		consoleError.mockReset()
	}
})

function previewTotalling(total: number) {
	return jsonResponse({ object: 'credit_note', total, currency: 'usd' })
}

function lineAmountsOf(url: unknown) {
	const params = new URL(url as string).searchParams
	return [...params.entries()]
		.filter(([key]) => /^lines\[\d+\]\[amount\]$/.test(key))
		.map(([, value]) => Number(value))
}

test('stripe client scales a credit note down to the refund cap before issuing it', async () => {
	const env = { STRIPE_SECRET_KEY: 'sk_test_secret' }
	const issued = (refundAmount: number) =>
		jsonResponse({
			id: 'cn_capped',
			object: 'credit_note',
			invoice: 'in_upgrade',
			total: refundAmount,
			currency: 'usd',
			status: 'issued',
			metadata: { kody_account_deletion: '1' },
		})

	// Preview exceeds the cap: every line is scaled by cap / total (floored)
	// and previewed again before the note is created for the second total.
	let fetchMock = vi
		.fn()
		.mockResolvedValueOnce(previewTotalling(2610))
		.mockResolvedValueOnce(previewTotalling(1699))
		.mockResolvedValueOnce(issued(1699))
	vi.stubGlobal('fetch', fetchMock)
	try {
		await expect(
			createProratedRefundCreditNote(env, {
				invoiceId: 'in_upgrade',
				subscriptionId: 'sub_1',
				lines: [
					{ invoiceLineItemId: 'il_pro', amount: 2000 },
					{ invoiceLineItemId: 'il_addon', amount: 610 },
				],
				maxRefundMinor: 1700,
				reason: 'order_change',
			}),
		).resolves.toEqual({
			outcome: 'issued',
			id: 'cn_capped',
			total: 1699,
			currency: 'usd',
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(lineAmountsOf(fetchMock.mock.calls[0]![0])).toEqual([2000, 610])
		// floor(2000 * 1700 / 2610) = 1302, floor(610 * 1700 / 2610) = 397
		expect(lineAmountsOf(fetchMock.mock.calls[1]![0])).toEqual([1302, 397])
		const createForm = Object.fromEntries(
			new URLSearchParams(
				(fetchMock.mock.calls[2]![1] as RequestInit).body as string,
			),
		)
		expect(createForm).toMatchObject({
			'lines[0][amount]': '1302',
			'lines[1][amount]': '397',
			refund_amount: '1699',
		})

		// Discount and tax rounding can leave the scaled preview a hair above
		// the cap; the lines are scaled by the new ratio (gross amounts against
		// the net, tax-inclusive preview only ever meet as a ratio) and
		// previewed again until the total fits.
		fetchMock = vi
			.fn()
			.mockResolvedValueOnce(previewTotalling(2610))
			.mockResolvedValueOnce(previewTotalling(1702))
			.mockResolvedValueOnce(previewTotalling(1701))
			.mockResolvedValueOnce(previewTotalling(1700))
			.mockResolvedValueOnce(issued(1700))
		vi.stubGlobal('fetch', fetchMock)
		await expect(
			createProratedRefundCreditNote(env, {
				invoiceId: 'in_upgrade',
				subscriptionId: 'sub_1',
				lines: [
					{ invoiceLineItemId: 'il_pro', amount: 2000 },
					{ invoiceLineItemId: 'il_addon', amount: 610 },
				],
				maxRefundMinor: 1700,
				reason: 'order_change',
			}),
		).resolves.toEqual({
			outcome: 'issued',
			id: 'cn_capped',
			total: 1700,
			currency: 'usd',
		})
		expect(fetchMock).toHaveBeenCalledTimes(5)
		// floor(1302 * 1700 / 1702) = 1300, floor(397 * 1700 / 1702) = 396
		expect(lineAmountsOf(fetchMock.mock.calls[2]![0])).toEqual([1300, 396])
		// floor(1300 * 1700 / 1701) = 1299, floor(396 * 1700 / 1701) = 395
		expect(lineAmountsOf(fetchMock.mock.calls[3]![0])).toEqual([1299, 395])
		expect(
			Object.fromEntries(
				new URLSearchParams(
					(fetchMock.mock.calls[4]![1] as RequestInit).body as string,
				),
			),
		).toMatchObject({
			'lines[0][amount]': '1299',
			'lines[1][amount]': '395',
			refund_amount: '1700',
		})

		// A cap so small every line floors to zero means nothing to refund.
		fetchMock = vi.fn().mockResolvedValueOnce(previewTotalling(2610))
		vi.stubGlobal('fetch', fetchMock)
		await expect(
			createProratedRefundCreditNote(env, {
				invoiceId: 'in_upgrade',
				subscriptionId: 'sub_1',
				lines: [
					{ invoiceLineItemId: 'il_pro', amount: 1305 },
					{ invoiceLineItemId: 'il_addon', amount: 1305 },
				],
				maxRefundMinor: 1,
				reason: 'order_change',
			}),
		).resolves.toEqual({ outcome: 'nothing_to_refund' })
		expect(fetchMock).toHaveBeenCalledOnce()

		// A preview that never drops under the cap however far the lines shrink
		// stops after the attempt budget and reports unfittable instead of
		// throwing or issuing a note above the cap; the caller decides what a
		// missing refund means.
		fetchMock = vi.fn(async () => previewTotalling(1705))
		vi.stubGlobal('fetch', fetchMock)
		await expect(
			createProratedRefundCreditNote(env, {
				invoiceId: 'in_upgrade',
				subscriptionId: 'sub_1',
				lines: [{ invoiceLineItemId: 'il_pro', amount: 2610 }],
				maxRefundMinor: 1700,
				reason: 'order_change',
			}),
		).resolves.toEqual({ outcome: 'unfittable', lastPreviewMinor: 1705 })
		expect(fetchMock).toHaveBeenCalledTimes(creditNoteCapFitAttempts + 1)
		const attemptedAmounts = fetchMock.mock.calls.map(
			([url]) => lineAmountsOf(url)[0],
		)
		// Every pass shrinks the line: floor(2610 * 1700 / 1705) = 2602, ...
		expect(attemptedAmounts).toEqual([2610, 2602, 2594, 2586, 2578, 2570, 2562])
		for (const [url, init] of fetchMock.mock.calls) {
			expect(new URL(url as string).pathname).toBe('/v1/credit_notes/preview')
			expect(init).toMatchObject({ method: 'GET' })
		}

		// A rejected create names the invoice and the amounts involved (never
		// Stripe's message, which can embed other ids) so it is diagnosable.
		consoleError.mockImplementation(() => {})
		fetchMock = vi
			.fn()
			.mockResolvedValueOnce(previewTotalling(1450))
			.mockResolvedValueOnce(
				jsonResponse(
					{
						error: {
							type: 'invalid_request_error',
							message:
								'Credit note amount for in_upgrade exceeds the remaining creditable amount.',
						},
					},
					400,
				),
			)
		vi.stubGlobal('fetch', fetchMock)
		const rejected = await createProratedRefundCreditNote(env, {
			invoiceId: 'in_upgrade',
			subscriptionId: 'sub_1',
			lines: [{ invoiceLineItemId: 'il_pro', amount: 1450 }],
			maxRefundMinor: 1700,
			reason: 'order_change',
		}).then(
			() => null,
			(thrown: unknown) => thrown,
		)
		expect(rejected).toMatchObject({
			name: 'StripeApiError',
			status: 400,
			message:
				'Stripe rejected the credit note for in_upgrade (previewed 1450, cap 1700, HTTP 400).',
			stripeMessage: expect.stringContaining('exceeds'),
		})
		expect(isStripeNothingToRefundError(rejected)).toBe(false)
		expect(consoleError).toHaveBeenCalledWith('stripe_api_error', {
			status: 400,
			path: '/v1/credit_notes',
		})
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
