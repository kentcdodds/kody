import { expect, test, vi } from 'vitest'
import { planLimits } from '#universal/plans.ts'
import {
	runComputeOverageBilling,
	shouldInvoiceComputeOverageMonth,
} from './compute-overage-invoices.ts'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

type LedgerRow = {
	status: string
	stripe_invoice_id: string | null
}

type Candidate = {
	id: number
	stable_user_id: string
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	stripe_customer_id: string | null
	uniqueWorkerDays: number
}

function createBillingDb(input: {
	candidates: Array<Candidate>
	ledger?: Map<string, LedgerRow>
	chargingEnabled?: boolean
	chargingOverrideEnabled?: boolean
}) {
	const ledger = input.ledger ?? new Map<string, LedgerRow>()
	const inserts: Array<Record<string, unknown>> = []
	return {
		ledger,
		inserts,
		db: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				const statement = {
					bind(...params: Array<unknown>) {
						statement.params = params
						return statement
					},
					params: [] as Array<unknown>,
					async all<T>() {
						if (
							normalized.includes('from users u') &&
							normalized.includes('left join usage_rollups')
						) {
							const month = String(statement.params[0])
							const startAfter = String(statement.params[1])
							const limit = Number(statement.params.at(-1))
							const results = input.candidates
								.filter((row) => row.stable_user_id > startAfter)
								.filter((row) => {
									const existing = ledger.get(`${row.stable_user_id}:${month}`)
									if (!existing) return true
									return (
										existing.status === 'pending' ||
										existing.status === 'failed'
									)
								})
								.slice(0, limit)
							return { results: results as Array<T> }
						}
						if (
							normalized.includes('from usage_rollups') &&
							normalized.includes('metric, event_count')
						) {
							const userId = String(statement.params[0])
							const candidate = input.candidates.find(
								(row) => row.stable_user_id === userId,
							)
							return {
								results: candidate
									? [
											{
												metric: 'dynamic_worker_day',
												event_count: candidate.uniqueWorkerDays,
											},
										]
									: [],
							}
						}
						return { results: [] }
					},
					async first<T>() {
						if (normalized.includes('from compute_overage_invoices')) {
							const key = `${String(statement.params[0])}:${String(statement.params[1])}`
							return (ledger.get(key) as T | undefined) ?? null
						}
						if (normalized.includes('from feature_flag_user_overrides')) {
							if (input.chargingOverrideEnabled === true) {
								return { enabled: 1 } as T
							}
							if (input.chargingOverrideEnabled === false) {
								return { enabled: 0 } as T
							}
							return null
						}
						if (normalized.includes('from feature_flags')) {
							if (input.chargingEnabled === false) {
								return { enabled: 0, rollout_percent: null } as T
							}
							if (input.chargingEnabled === true) {
								return { enabled: 1, rollout_percent: null } as T
							}
							return null
						}
						return null
					},
					async run() {
						if (normalized.includes('insert into compute_overage_invoices')) {
							const [
								userId,
								month,
								uniqueWorkerDays,
								,
								,
								,
								,
								disposition,
								status,
								,
								invoiceId,
							] = statement.params
							const key = `${String(userId)}:${String(month)}`
							ledger.set(key, {
								status: String(status),
								stripe_invoice_id:
									typeof invoiceId === 'string' ? invoiceId : null,
							})
							inserts.push({
								userId,
								month,
								uniqueWorkerDays,
								disposition,
								status,
								invoiceId,
							})
						}
						return { success: true }
					},
				}
				return statement
			},
		} as unknown as D1Database,
	}
}

function stripeInvoiceFetchStub(input: {
	createId?: string
	existing?: Array<{
		id: string
		status: string
		amount_due: number
		metadata?: Record<string, string>
	}>
	payShouldFail?: boolean
}) {
	return vi.fn(async (url: string | URL, init?: RequestInit) => {
		const parsed = new URL(String(url), 'https://api.stripe.com')
		const method = (init?.method ?? 'GET').toUpperCase()
		if (method === 'GET' && parsed.pathname === '/v1/invoices') {
			return jsonResponse({ data: input.existing ?? [] })
		}
		if (method === 'GET' && parsed.pathname.startsWith('/v1/invoices/')) {
			const id = decodeURIComponent(parsed.pathname.split('/').at(-1) ?? '')
			const found = (input.existing ?? []).find((invoice) => invoice.id === id)
			if (!found) return jsonResponse({ error: { message: 'missing' } }, 404)
			return jsonResponse({
				id: found.id,
				status: found.status,
				amount_due: found.amount_due,
				currency: 'usd',
				metadata: found.metadata ?? {},
			})
		}
		if (method === 'POST' && parsed.pathname === '/v1/invoices') {
			return jsonResponse({
				id: input.createId ?? 'in_paid_1',
				status: 'draft',
				amount_due: 0,
				currency: 'usd',
			})
		}
		if (parsed.pathname.endsWith('/v1/invoiceitems')) {
			return jsonResponse({
				id: 'ii_paid_1',
				invoice: input.createId ?? 'in_paid_1',
				amount: 100,
				currency: 'usd',
			})
		}
		if (parsed.pathname.endsWith('/finalize')) {
			return jsonResponse({
				id: input.createId ?? 'in_paid_1',
				status: 'open',
				amount_due: 100,
				currency: 'usd',
			})
		}
		if (parsed.pathname.endsWith('/pay')) {
			if (input.payShouldFail) {
				return jsonResponse({ error: { message: 'card_declined' } }, 402)
			}
			return jsonResponse({
				id: input.createId ?? 'in_paid_1',
				status: 'paid',
				amount_due: 0,
				currency: 'usd',
			})
		}
		return jsonResponse({ error: { message: 'unexpected' } }, 500)
	})
}

test('compute overage window skips day-1 hour 0 and days after the catch-up', () => {
	expect(
		shouldInvoiceComputeOverageMonth(new Date('2026-09-01T00:30:00.000Z')),
	).toBe(false)
	expect(
		shouldInvoiceComputeOverageMonth(new Date('2026-09-01T01:00:00.000Z')),
	).toBe(true)
	expect(
		shouldInvoiceComputeOverageMonth(new Date('2026-09-03T23:00:00.000Z')),
	).toBe(true)
	expect(
		shouldInvoiceComputeOverageMonth(new Date('2026-09-04T00:00:00.000Z')),
	).toBe(false)
})

test('billing job skips outside the window and when Stripe is unconfigured', async () => {
	const { db } = createBillingDb({ candidates: [] })
	await expect(
		runComputeOverageBilling({
			env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
			now: new Date('2026-09-06T12:00:00.000Z'),
		}),
	).resolves.toEqual({ status: 'skipped', reason: 'outside_window' })
	await expect(
		runComputeOverageBilling({
			env: { APP_DB: db } as Env,
			now: new Date('2026-09-02T12:00:00.000Z'),
		}),
	).resolves.toEqual({ status: 'skipped', reason: 'billing_unconfigured' })
})

test('unpaid Free and legacy never call Stripe', async () => {
	const fetchStub = vi.fn()
	vi.stubGlobal('fetch', fetchStub)
	try {
		const { db, inserts } = createBillingDb({
			candidates: [
				{
					id: 1,
					stable_user_id: 'a'.repeat(64),
					plan: 'free',
					stripe_plan: null,
					entitlement_ladder: 'public',
					stripe_customer_id: null,
					uniqueWorkerDays: planLimits.free.maxUniqueWorkerDaysPerMonth + 12,
				},
				{
					id: 2,
					stable_user_id: 'b'.repeat(64),
					plan: 'pro',
					stripe_plan: 'pro',
					entitlement_ladder: 'legacy',
					stripe_customer_id: 'cus_legacy',
					uniqueWorkerDays: planLimits.pro.maxUniqueWorkerDaysPerMonth + 100,
				},
			],
		})
		const result = await runComputeOverageBilling({
			env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
			now: new Date('2026-09-02T12:00:00.000Z'),
		})
		expect(result).toMatchObject({
			status: 'completed',
			month: '2026-08',
			scanned: 2,
			softBlocked: 1,
			skippedLegacy: 1,
			invoiced: 0,
		})
		expect(fetchStub).not.toHaveBeenCalled()
		expect(inserts.map((row) => row.status).sort()).toEqual([
			'skip_legacy',
			'soft_block',
		])
	} finally {
		vi.unstubAllGlobals()
	}
})

test('paid public invoices through Stripe invoice items when charging is on', async () => {
	const fetchStub = stripeInvoiceFetchStub({ createId: 'in_paid_1' })
	vi.stubGlobal('fetch', fetchStub)
	try {
		const { db, inserts } = createBillingDb({
			candidates: [
				{
					id: 3,
					stable_user_id: 'c'.repeat(64),
					plan: 'standard',
					stripe_plan: 'standard',
					entitlement_ladder: 'public',
					stripe_customer_id: 'cus_paid',
					uniqueWorkerDays:
						planLimits.standard.maxUniqueWorkerDaysPerMonth + 400,
				},
			],
		})
		const result = await runComputeOverageBilling({
			env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
			now: new Date('2026-09-02T12:00:00.000Z'),
		})
		expect(result).toMatchObject({
			status: 'completed',
			invoiced: 1,
			failed: 0,
		})
		expect(fetchStub).toHaveBeenCalled()
		expect(inserts.at(-1)).toMatchObject({
			status: 'invoiced',
			invoiceId: 'in_paid_1',
		})
		const paths = fetchStub.mock.calls.map(([url]) => String(url))
		expect(paths.some((path) => path.endsWith('/v1/invoices'))).toBe(true)
		expect(paths.some((path) => path.endsWith('/v1/invoiceitems'))).toBe(true)
		expect(paths.some((path) => path.endsWith('/finalize'))).toBe(true)
		expect(paths.some((path) => path.endsWith('/pay'))).toBe(true)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('global flag off writes dry-run and does not call Stripe', async () => {
	const fetchStub = vi.fn()
	vi.stubGlobal('fetch', fetchStub)
	try {
		const { db, inserts } = createBillingDb({
			chargingEnabled: false,
			candidates: [
				{
					id: 4,
					stable_user_id: 'd'.repeat(64),
					plan: 'standard',
					stripe_plan: 'standard',
					entitlement_ladder: 'public',
					stripe_customer_id: 'cus_paid',
					uniqueWorkerDays:
						planLimits.standard.maxUniqueWorkerDaysPerMonth + 400,
				},
			],
		})
		const result = await runComputeOverageBilling({
			env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
			now: new Date('2026-09-02T12:00:00.000Z'),
		})
		expect(result).toMatchObject({
			status: 'completed',
			dryRun: 1,
			invoiced: 0,
		})
		expect(fetchStub).not.toHaveBeenCalled()
		expect(inserts.at(-1)?.status).toBe('dry_run')
	} finally {
		vi.unstubAllGlobals()
	}
})

test('per-user on override cannot invoice while the global flag is off', async () => {
	const fetchStub = vi.fn()
	vi.stubGlobal('fetch', fetchStub)
	try {
		const { db, inserts } = createBillingDb({
			chargingEnabled: false,
			chargingOverrideEnabled: true,
			candidates: [
				{
					id: 5,
					stable_user_id: 'e'.repeat(64),
					plan: 'standard',
					stripe_plan: 'standard',
					entitlement_ladder: 'public',
					stripe_customer_id: 'cus_paid',
					uniqueWorkerDays:
						planLimits.standard.maxUniqueWorkerDaysPerMonth + 400,
				},
			],
		})
		const result = await runComputeOverageBilling({
			env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
			now: new Date('2026-09-02T12:00:00.000Z'),
		})
		expect(result).toMatchObject({
			status: 'completed',
			dryRun: 1,
			invoiced: 0,
		})
		expect(fetchStub).not.toHaveBeenCalled()
		expect(inserts.at(-1)?.status).toBe('dry_run')
	} finally {
		vi.unstubAllGlobals()
	}
})

test('billing job pages past the first batch and skips terminal ledger rows', async () => {
	const invoicedId = 'a'.repeat(64)
	const firstPage = Array.from({ length: 25 }, (_, index) => ({
		id: 100 + index,
		stable_user_id: `b${String(index).padStart(2, '0')}${'x'.repeat(61)}`,
		plan: 'free',
		stripe_plan: null,
		entitlement_ladder: 'public',
		stripe_customer_id: null,
		uniqueWorkerDays: 1,
	}))
	const lastUser = {
		id: 200,
		stable_user_id: 'c'.repeat(64),
		plan: 'free',
		stripe_plan: null,
		entitlement_ladder: 'public',
		stripe_customer_id: null,
		uniqueWorkerDays: 12,
	}
	const ledger = new Map<string, LedgerRow>([
		[
			`${invoicedId}:2026-08`,
			{ status: 'invoiced', stripe_invoice_id: 'in_old' },
		],
	])
	const { db, inserts } = createBillingDb({
		candidates: [
			{
				id: 99,
				stable_user_id: invoicedId,
				plan: 'standard',
				stripe_plan: 'standard',
				entitlement_ladder: 'public',
				stripe_customer_id: 'cus_old',
				uniqueWorkerDays: planLimits.standard.maxUniqueWorkerDaysPerMonth + 400,
			},
			...firstPage,
			lastUser,
		],
		ledger,
	})
	const result = await runComputeOverageBilling({
		env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
		now: new Date('2026-09-02T12:00:00.000Z'),
	})
	expect(result).toMatchObject({
		status: 'completed',
		scanned: 26,
		done: true,
		invoiced: 0,
	})
	expect(
		inserts.some(
			(row) => row.userId === invoicedId && row.status === 'invoiced',
		),
	).toBe(false)
	expect(inserts.some((row) => row.userId === lastUser.stable_user_id)).toBe(
		true,
	)
})

test('sub-minimum public overage is recorded as skip_below_minimum, not invoiced', async () => {
	const fetchStub = vi.fn()
	vi.stubGlobal('fetch', fetchStub)
	try {
		const { db, inserts } = createBillingDb({
			candidates: [
				{
					id: 6,
					stable_user_id: 'f'.repeat(64),
					plan: 'standard',
					stripe_plan: 'standard',
					entitlement_ladder: 'public',
					stripe_customer_id: 'cus_paid',
					uniqueWorkerDays:
						planLimits.standard.maxUniqueWorkerDaysPerMonth + 12,
				},
			],
		})
		const result = await runComputeOverageBilling({
			env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
			now: new Date('2026-09-02T12:00:00.000Z'),
		})
		expect(result).toMatchObject({
			status: 'completed',
			invoiced: 0,
			scanned: 1,
		})
		expect(fetchStub).not.toHaveBeenCalled()
		expect(inserts.at(-1)).toMatchObject({
			status: 'skip_below_minimum',
			uniqueWorkerDays: planLimits.standard.maxUniqueWorkerDaysPerMonth + 12,
		})
	} finally {
		vi.unstubAllGlobals()
	}
})

test('retry resumes the stored Stripe invoice instead of creating a second one', async () => {
	const fetchStub = stripeInvoiceFetchStub({
		createId: 'in_resume_1',
		existing: [
			{
				id: 'in_resume_1',
				status: 'draft',
				amount_due: 0,
			},
		],
	})
	vi.stubGlobal('fetch', fetchStub)
	try {
		const userId = 'g'.repeat(64)
		const { db, inserts } = createBillingDb({
			candidates: [
				{
					id: 7,
					stable_user_id: userId,
					plan: 'standard',
					stripe_plan: 'standard',
					entitlement_ladder: 'public',
					stripe_customer_id: 'cus_paid',
					uniqueWorkerDays:
						planLimits.standard.maxUniqueWorkerDaysPerMonth + 400,
				},
			],
			ledger: new Map([
				[
					`${userId}:2026-08`,
					{ status: 'failed', stripe_invoice_id: 'in_resume_1' },
				],
			]),
		})
		const result = await runComputeOverageBilling({
			env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
			now: new Date('2026-09-02T12:00:00.000Z'),
		})
		expect(result).toMatchObject({
			status: 'completed',
			invoiced: 1,
			failed: 0,
		})
		const methods = fetchStub.mock.calls.map(([url, init]) => ({
			url: String(url),
			method: String((init as RequestInit | undefined)?.method ?? 'GET'),
		}))
		expect(
			methods.some(
				(call) => call.method === 'POST' && call.url.endsWith('/v1/invoices'),
			),
		).toBe(false)
		expect(
			methods.some((call) => call.url.includes('/v1/invoices/in_resume_1')),
		).toBe(true)
		expect(inserts.at(-1)).toMatchObject({
			status: 'invoiced',
			invoiceId: 'in_resume_1',
		})
	} finally {
		vi.unstubAllGlobals()
	}
})

test('ledger stores actual usage, not the include allotment', async () => {
	const { db, inserts } = createBillingDb({
		candidates: [
			{
				id: 8,
				stable_user_id: 'h'.repeat(64),
				plan: 'free',
				stripe_plan: null,
				entitlement_ladder: 'public',
				stripe_customer_id: null,
				uniqueWorkerDays: 12,
			},
		],
	})
	await runComputeOverageBilling({
		env: { APP_DB: db, STRIPE_SECRET_KEY: 'sk_test' } as Env,
		now: new Date('2026-09-02T12:00:00.000Z'),
	})
	expect(inserts.at(-1)).toMatchObject({
		status: 'skip_zero',
		uniqueWorkerDays: 12,
	})
})
