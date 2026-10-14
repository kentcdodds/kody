import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildCreditAutoRefillIdempotencyKey,
	creditAutoRefillMetadataKey,
	runCreditAutoRefill,
} from './credit-auto-refill.ts'
import { updateCreditWalletSettings } from './credit-wallet.ts'
import { KODY_STABLE_USER_ID_METADATA_KEY } from './org-stripe-metadata.ts'

const now = new Date('2026-09-27T12:00:00.000Z')
const userId = 'user-refill-test'
const customerId = 'cus_refill_test'
const paymentMethodId = 'pm_refill_test'
const amountCents = 1_000

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function idempotencyMismatchResponse() {
	return jsonResponse(
		{
			error: {
				message:
					'Keys for idempotent requests can only be used with the same parameters they were first used with.',
				type: 'idempotency_error',
			},
		},
		400,
	)
}

function formOf(init: unknown) {
	return Object.fromEntries(
		new URLSearchParams((init as RequestInit).body as string),
	)
}

function createTestEnv(db: D1Database) {
	return {
		APP_DB: db,
		STRIPE_SECRET_KEY: 'sk_test_secret',
		STRIPE_API_BASE_URL: 'https://stripe.mock',
	} as unknown as Env
}

async function seedWallet(db: D1Database) {
	await updateCreditWalletSettings({
		db,
		userId,
		autoRefill: {
			enabled: true,
			thresholdCents: 500,
			amountCents,
			monthlyCapCents: 10_000,
		},
		notify: { autoRefilled: false, monthlyCap: false, lowBalance: false },
		now,
	})
	await db
		.prepare(
			`UPDATE credit_wallets
			 SET balance_micro_usd = 0,
			     auto_refill_payment_method_id = ?
			 WHERE user_id = ?`,
		)
		.bind(paymentMethodId, userId)
		.run()
}

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

beforeEach(() => {
	vi.restoreAllMocks()
})

test('runCreditAutoRefill heals idempotency mismatch via legacy metadata replay', async () => {
	const { db } = createDb()
	await seedWallet(db)
	const env = createTestEnv(db)
	const succeededIntent = {
		id: 'pi_legacy_cached',
		status: 'succeeded',
		amount: amountCents,
		currency: 'usd',
	}
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.includes('/v1/payment_intents?')) {
			return jsonResponse({ data: [] })
		}
		if (method === 'POST' && url.includes('/v1/payment_intents')) {
			const key = (init?.headers as Record<string, string>)?.['idempotency-key']
			if (key?.endsWith(':v2')) {
				return idempotencyMismatchResponse()
			}
			expect(formOf(init)).toMatchObject({
				[`metadata[${creditAutoRefillMetadataKey}]`]: '1',
				[`metadata[${KODY_STABLE_USER_ID_METADATA_KEY}]`]: userId,
			})
			expect(key).toBe(
				buildCreditAutoRefillIdempotencyKey({
					userId,
					month: '2026-09',
					refillNumber: 1,
					version: 'legacy',
				}),
			)
			return jsonResponse(succeededIntent)
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await runCreditAutoRefill({
				env,
				userId,
				email: 'user@example.com',
				stripeCustomerId: customerId,
				now,
			}),
		).toBe('charged')
		const ledger = await db
			.prepare(
				`SELECT stripe_reference, kind FROM credit_ledger_entries WHERE user_id = ?`,
			)
			.bind(userId)
			.first<{ stripe_reference: string; kind: string }>()
		expect(ledger).toEqual({
			stripe_reference: 'pi_legacy_cached',
			kind: 'auto_refill',
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('runCreditAutoRefill applies an unledgered succeeded PaymentIntent from listing', async () => {
	const { db } = createDb()
	await seedWallet(db)
	const env = createTestEnv(db)
	const orphanIntent = {
		id: 'pi_orphan_succeeded',
		status: 'succeeded',
		amount: amountCents,
		currency: 'usd',
		metadata: {
			[creditAutoRefillMetadataKey]: '1',
			kody_org_id: userId,
			[KODY_STABLE_USER_ID_METADATA_KEY]: userId,
		},
	}
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.includes('/v1/payment_intents?')) {
			return jsonResponse({ data: [orphanIntent] })
		}
		if (method === 'POST') {
			return idempotencyMismatchResponse()
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await runCreditAutoRefill({
				env,
				userId,
				email: 'user@example.com',
				stripeCustomerId: customerId,
				now,
			}),
		).toBe('charged')
		const ledger = await db
			.prepare(
				`SELECT stripe_reference FROM credit_ledger_entries WHERE user_id = ?`,
			)
			.bind(userId)
			.first<{ stripe_reference: string }>()
		expect(ledger?.stripe_reference).toBe('pi_orphan_succeeded')
		expect(
			fetchMock.mock.calls.some(
				([requestUrl, requestInit]) =>
					(requestInit?.method ?? 'GET') === 'POST' &&
					String(requestUrl).includes('/v1/payment_intents'),
			),
		).toBe(false)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('runCreditAutoRefill lists then creates with v2 when no orphan exists', async () => {
	const { db } = createDb()
	await seedWallet(db)
	const env = createTestEnv(db)
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.includes('/v1/payment_intents?')) {
			return jsonResponse({ data: [] })
		}
		if (method === 'POST' && url.includes('/v1/payment_intents')) {
			const key = (init?.headers as Record<string, string>)?.['idempotency-key']
			expect(key).toBe(
				buildCreditAutoRefillIdempotencyKey({
					userId,
					month: '2026-09',
					refillNumber: 1,
					version: 'v2',
				}),
			)
			return jsonResponse({
				id: 'pi_new_v2',
				status: 'succeeded',
				amount: amountCents,
				currency: 'usd',
			})
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`)
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		expect(
			await runCreditAutoRefill({
				env,
				userId,
				email: 'user@example.com',
				stripeCustomerId: customerId,
				now,
			}),
		).toBe('charged')
		expect(fetchMock).toHaveBeenCalledTimes(2)
	} finally {
		vi.unstubAllGlobals()
	}
})
