import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { cancelKodySubscriptionsForSoftDelete } from './soft-delete-billing.ts'

vi.mock('./stripe-client.ts', () => ({
	listSubscriptions: vi.fn(async () => [
		{
			id: 'sub_live',
			status: 'active',
			items: {
				data: [{ price: { id: 'price_pro', product: 'prod_kody' } }],
			},
		},
		{
			id: 'sub_other',
			status: 'active',
			items: {
				data: [{ price: { id: 'price_other', product: 'prod_other' } }],
			},
		},
	]),
	cancelSubscription: vi.fn(async () => undefined),
}))

vi.mock('./billing-config.ts', () => ({
	isKodySubscription: (_env: Env, subscription: { id: string }) =>
		subscription.id === 'sub_live',
}))

const { listSubscriptions, cancelSubscription } =
	await import('./stripe-client.ts')

test('cancelKodySubscriptionsForSoftDelete finds customer on soft-deleted org', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const db = createD1FromSqlite(sqlite)
	const ts = '2026-01-01T00:00:00.000Z'
	const orgId = 'org-soft-billing'
	await db
		.prepare(
			`INSERT INTO orgs (
				id, slug, display_name, plan, entitlement_ladder,
				stripe_customer_id, created_at, updated_at, deleted_at
			) VALUES (?, 'soft-billing', 'Soft Billing', 'pro', 'public', ?, ?, ?, ?)`,
		)
		.bind(orgId, 'cus_soft_billing', ts, ts, ts)
		.run()

	vi.mocked(listSubscriptions).mockClear()
	vi.mocked(cancelSubscription).mockClear()

	const result = await cancelKodySubscriptionsForSoftDelete({
		env: { APP_DB: db, STRIPE_PRO_PRICE_ID: 'price_pro' } as unknown as Env,
		ownerId: orgId,
	})

	expect(result).toEqual({ canceled: 1, customerId: 'cus_soft_billing' })
	expect(listSubscriptions).toHaveBeenCalledWith(
		expect.anything(),
		'cus_soft_billing',
	)
	expect(cancelSubscription).toHaveBeenCalledWith(expect.anything(), 'sub_live')
	expect(cancelSubscription).not.toHaveBeenCalledWith(
		expect.anything(),
		'sub_other',
	)
})
