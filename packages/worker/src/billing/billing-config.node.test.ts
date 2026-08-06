import { expect, test } from 'vitest'
import {
	createBillingLinkReference,
	getPurchasablePlans,
	resolveSubscriptionPlan,
} from './billing-config.ts'
import { type StripeSubscription } from './stripe-client.ts'

function subscription(input: {
	id?: string
	status: string
	cancel_at?: number | null
	priceIds?: Array<string>
	metadata?: Record<string, string>
}): StripeSubscription {
	return {
		id: input.id ?? 'sub_test',
		status: input.status,
		cancel_at: input.cancel_at ?? null,
		metadata: input.metadata,
		items: {
			data: (input.priceIds ?? []).map((id) => ({ price: { id } })),
		},
	}
}

test('createBillingLinkReference is stable per user and not the raw stable id', async () => {
	const envStub = { COOKIE_SECRET: 'x'.repeat(32) }
	const first = await createBillingLinkReference(envStub, 'stable-user-1')
	const second = await createBillingLinkReference(envStub, 'stable-user-1')
	const other = await createBillingLinkReference(envStub, 'stable-user-2')
	const otherSecret = await createBillingLinkReference(
		{ COOKIE_SECRET: 'y'.repeat(32) },
		'stable-user-1',
	)
	expect(first).toBe(second)
	expect(first).not.toBe('stable-user-1')
	expect(first).not.toBe(other)
	expect(first).not.toBe(otherSecret)
	expect(first).toMatch(/^[0-9a-f]{64}$/)
})

test('resolveSubscriptionPlan maps active price and metadata plans with soonest cancel_at', () => {
	const env = {
		STRIPE_STANDARD_PRICE_ID: 'price_standard',
		STRIPE_PRO_PRICE_ID: 'price_pro',
	}

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'canceled',
					priceIds: ['price_pro'],
				}),
				subscription({
					status: 'incomplete',
					priceIds: ['price_pro'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: null,
		cancelAt: null,
		subscriptionStatus: 'incomplete',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_standard'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: 'standard',
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_pro'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: 'pro',
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'trialing',
					priceIds: ['price_pro'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: 'pro',
		cancelAt: null,
		subscriptionStatus: 'trialing',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_other'],
					metadata: { kody_plan: 'pro' },
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: 'pro',
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	// Retired plan names in metadata contribute nothing.
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_other'],
					metadata: { kody_plan: 'partner' },
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: null,
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_standard'],
					metadata: { kody_plan: 'partner' },
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: 'standard',
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_unknown'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: null,
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_unknown'],
					metadata: { kody_plan: 'unlimited' },
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: null,
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_unknown'],
					metadata: { kody_plan: 'max' },
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: null,
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	const sooner = 1_700_000_000
	const later = 1_800_000_000
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_pro'],
					cancel_at: later,
				}),
				subscription({
					status: 'trialing',
					priceIds: ['price_pro'],
					cancel_at: sooner,
				}),
				subscription({
					status: 'canceled',
					priceIds: ['price_pro'],
					cancel_at: 1,
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: 'pro',
		cancelAt: new Date(sooner * 1000).toISOString(),
		subscriptionStatus: 'active',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'canceled',
					priceIds: ['price_pro'],
				}),
				subscription({
					status: 'past_due',
					priceIds: ['price_pro'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: null,
		cancelAt: null,
		subscriptionStatus: 'past_due',
	})
})

test('price ids independently control purchasable tiers', () => {
	expect(
		getPurchasablePlans({
			STRIPE_STANDARD_PRICE_ID: 'price_standard',
		}),
	).toEqual(['standard'])
	expect(getPurchasablePlans({ STRIPE_PRO_PRICE_ID: 'price_pro' })).toEqual([
		'pro',
	])
	expect(getPurchasablePlans({})).toEqual([])
})
