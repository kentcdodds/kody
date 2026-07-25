import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

const refreshStripePlanForUser = vi.hoisted(() =>
	vi.fn(async () => ({
		stripePlan: 'pro' as const,
		cancelAt: null as string | null,
		subscriptionStatus: 'active' as string | null,
	})),
)

vi.mock('#worker/billing/subscription-sync.ts', () => ({
	refreshStripePlanForUser,
}))

import {
	loadAccountBillingData,
	resolveBillingErrorMessage,
} from '#app/account-billing-data.ts'

function createBillingTestDb(input: {
	plan: string
	stripePlan?: string | null
	stripeCustomerId?: string | null
}) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalized.includes('from users') &&
								normalized.includes('where id')
							) {
								void params
								return {
									plan: input.plan,
									stripe_plan: input.stripePlan ?? null,
									stripe_customer_id: input.stripeCustomerId ?? null,
									stripe_plan_refreshed_at: null,
								} as T
							}
							return null
						},
						async run() {
							return { success: true }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('resolveBillingErrorMessage maps known codes and passes through unknown', () => {
	expect(resolveBillingErrorMessage('no_customer')).toContain('Subscribe first')
	expect(resolveBillingErrorMessage('totally_new_code')).toBe(
		'totally_new_code',
	)
	expect(resolveBillingErrorMessage(null)).toBeUndefined()
})

test('loadAccountBillingData passes subscriptionStatus from Stripe refresh', async () => {
	refreshStripePlanForUser.mockResolvedValueOnce({
		stripePlan: 'pro',
		cancelAt: '2026-08-01T00:00:00.000Z',
		subscriptionStatus: 'past_due',
	})

	const env = {
		APP_DB: createBillingTestDb({
			plan: 'free',
			stripePlan: 'pro',
			stripeCustomerId: 'cus_test',
		}),
		STRIPE_SECRET_KEY: 'sk_test',
		STRIPE_PRO_PRICE_ID: 'price_pro',
	} as Env

	const data = await loadAccountBillingData({
		env,
		userId: 9,
		now: new Date('2026-07-25T12:00:00.000Z'),
	})

	expect(data.ok).toBe(true)
	expect(data.configured).toBe(true)
	expect(data.hasStripeCustomer).toBe(true)
	expect(data.stripePlan).toBe('pro')
	expect(data.effectivePlan).toBe('pro')
	expect(data.subscriptionStatus).toBe('past_due')
	expect(data.cancelAt).toBe('2026-08-01T00:00:00.000Z')
	expect(data.usageHref).toBe('/account/usage')
	expect(data.checkoutAvailable).toBe(true)
	expect(refreshStripePlanForUser).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 9,
			customerId: 'cus_test',
		}),
	)
})

test('loadAccountBillingData leaves subscriptionStatus null when refresh fails', async () => {
	consoleError.mockImplementation(() => {})
	refreshStripePlanForUser.mockRejectedValueOnce(new Error('stripe down'))

	const env = {
		APP_DB: createBillingTestDb({
			plan: 'free',
			stripePlan: 'pro',
			stripeCustomerId: 'cus_test',
		}),
		STRIPE_SECRET_KEY: 'sk_test',
		STRIPE_PRO_PRICE_ID: 'price_pro',
	} as Env

	const data = await loadAccountBillingData({ env, userId: 3 })
	expect(data.stripePlan).toBe('pro')
	expect(data.subscriptionStatus).toBeNull()
	expect(data.cancelAt).toBeNull()
	expect(data.usageHref).toBe('/account/usage')
	expect(consoleError).toHaveBeenCalledWith(
		'account_billing_refresh_failed',
		expect.objectContaining({ userId: 3, error: 'stripe down' }),
	)
})

test('loadAccountBillingData skips refresh when there is no Stripe customer', async () => {
	refreshStripePlanForUser.mockClear()

	const env = {
		APP_DB: createBillingTestDb({
			plan: 'free',
			stripePlan: null,
			stripeCustomerId: null,
		}),
		STRIPE_SECRET_KEY: 'sk_test',
		STRIPE_PRO_PRICE_ID: 'price_pro',
	} as Env

	const data = await loadAccountBillingData({ env, userId: 4 })
	expect(data.hasStripeCustomer).toBe(false)
	expect(data.subscriptionStatus).toBeNull()
	expect(data.configured).toBe(true)
	expect(refreshStripePlanForUser).not.toHaveBeenCalled()
})
