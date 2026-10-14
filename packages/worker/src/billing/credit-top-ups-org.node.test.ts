import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'

const mocks = vi.hoisted(() => ({
	createBillingLinkReference: vi.fn(
		async (_env: Env, _userId: string) => 'ref-acme',
	),
	isBillingConfigured: vi.fn(() => true),
	applyCreditPayment: vi.fn(async (_input: unknown) => ({
		applied: true,
		balanceMicroUsd: 25_000_000,
	})),
	getCreditTopUpCheckoutSession: vi.fn(
		async (_env: Env, _sessionId: string) => ({
			id: 'cs_team',
			mode: 'payment' as const,
			payment_status: 'paid' as const,
			currency: 'usd',
			amount_total: 2500,
			client_reference_id: 'ref-acme',
			metadata: { kody_credit_top_up: '1' },
			payment_intent: { payment_method: null },
		}),
	),
}))

vi.mock('#worker/billing/billing-config.ts', () => ({
	createBillingLinkReference: mocks.createBillingLinkReference,
	isBillingConfigured: () => mocks.isBillingConfigured(),
}))

vi.mock('#worker/billing/credit-wallet.ts', () => ({
	applyCreditPayment: mocks.applyCreditPayment,
}))

vi.mock('#worker/billing/stripe-client.ts', () => ({
	createCreditTopUpCheckoutSession: vi.fn(),
	getCreditTopUpCheckoutSession: mocks.getCreditTopUpCheckoutSession,
}))

vi.mock('#worker/billing/org-stripe-metadata.ts', () => ({
	buildOrgBillingMetadata: (id: string) => ({ kody_org_id: id }),
	resolveOrgIdFromStripeMetadata: () => 'org-acme',
}))

const { applyCreditTopUpFromCheckoutSession } =
	await import('#worker/billing/credit-top-ups.ts')

beforeEach(() => {
	vi.clearAllMocks()
	mocks.createBillingLinkReference.mockResolvedValue('ref-acme')
	mocks.isBillingConfigured.mockReturnValue(true)
})

test('applyCreditTopUpFromCheckoutSession credits a team org wallet', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	sqlite.exec(`
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			deleting_at TEXT,
			deleted_at TEXT
		);
		INSERT INTO orgs (id, slug, deleting_at, deleted_at)
		VALUES ('org-acme', 'acme', NULL, NULL);
	`)

	const result = await applyCreditTopUpFromCheckoutSession({
		env: { APP_DB: db } as unknown as Env,
		sessionId: 'cs_team',
		expectedStableUserId: 'org-acme',
		now: new Date('2026-01-01T00:00:00.000Z'),
	})
	expect(result.stableUserId).toBe('org-acme')
	expect(mocks.applyCreditPayment).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'org-acme', amountCents: 2500 }),
	)
})

test('applyCreditTopUpFromCheckoutSession rejects an unknown org id', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	sqlite.exec(`
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			deleting_at TEXT,
			deleted_at TEXT
		);
	`)

	await expect(
		applyCreditTopUpFromCheckoutSession({
			env: { APP_DB: db } as unknown as Env,
			sessionId: 'cs_missing',
			expectedStableUserId: 'org-missing',
			now: new Date('2026-01-01T00:00:00.000Z'),
		}),
	).rejects.toMatchObject({ code: 'user_not_found' })
	expect(mocks.applyCreditPayment).not.toHaveBeenCalled()
})

test('applyCreditTopUpFromCheckoutSession rejects an org mid-delete', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	sqlite.exec(`
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			deleting_at TEXT,
			deleted_at TEXT
		);
		INSERT INTO orgs (id, slug, deleting_at, deleted_at)
		VALUES ('org-acme', 'acme', '2026-01-01T00:00:00.000Z', NULL);
	`)

	await expect(
		applyCreditTopUpFromCheckoutSession({
			env: { APP_DB: db } as unknown as Env,
			sessionId: 'cs_deleting',
			expectedStableUserId: 'org-acme',
			now: new Date('2026-01-01T00:00:00.000Z'),
		}),
	).rejects.toMatchObject({ code: 'user_not_found' })
	expect(mocks.applyCreditPayment).not.toHaveBeenCalled()
})
