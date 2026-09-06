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
							return { results: input.candidates as Array<T> }
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
							return null
						}
						if (normalized.includes('from feature_flags')) {
							if (input.chargingEnabled === false) {
								return { enabled: 0, rollout_percent: null } as T
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
								,
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
	const fetchStub = vi.fn(async (url: string | URL) => {
		const path = String(url)
		if (path.endsWith('/v1/invoices')) {
			return jsonResponse({
				id: 'in_paid_1',
				status: 'draft',
				amount_due: 0,
				currency: 'usd',
			})
		}
		if (path.endsWith('/v1/invoiceitems')) {
			return jsonResponse({
				id: 'ii_paid_1',
				invoice: 'in_paid_1',
				amount: 100,
				currency: 'usd',
			})
		}
		if (path.includes('/finalize') || path.includes('/pay')) {
			return jsonResponse({
				id: 'in_paid_1',
				status: 'paid',
				amount_due: 0,
				currency: 'usd',
			})
		}
		return jsonResponse({ error: { message: 'unexpected' } }, 500)
	})
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
