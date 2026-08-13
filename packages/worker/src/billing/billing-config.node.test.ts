import { expect, test } from 'vitest'
import {
	createBillingLinkReference,
	getPriceIdForPlan,
	getPurchasablePlans,
	parseBillingInterval,
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
		STRIPE_STANDARD_YEARLY_PRICE_ID: 'price_standard_yearly',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
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

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_standard_yearly'],
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
					priceIds: ['price_pro_yearly'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: 'pro',
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	// Retired production monthly prices still map after checkout rotates.
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_1Tv3W2LAQpAnsYszSr4PGBkE'],
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
					priceIds: ['price_1U1AISLAQpAnsYszIQvRJNhl'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: 'pro',
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	expect(getPurchasablePlans(env)).toEqual(['standard', 'pro'])
	expect(
		getPurchasablePlans({
			STRIPE_STANDARD_PRICE_ID: 'price_standard',
		}),
	).toEqual(['standard'])
	expect(getPurchasablePlans({ STRIPE_PRO_PRICE_ID: 'price_pro' })).toEqual([
		'pro',
	])
	expect(
		getPurchasablePlans({
			STRIPE_STANDARD_YEARLY_PRICE_ID: 'price_standard_yearly',
		}),
	).toEqual(['standard'])
	expect(getPurchasablePlans({})).toEqual([])

	expect(parseBillingInterval(undefined)).toBe('month')
	expect(parseBillingInterval(null)).toBe('month')
	expect(parseBillingInterval('')).toBe('month')
	expect(parseBillingInterval('month')).toBe('month')
	expect(parseBillingInterval('year')).toBe('year')
	expect(parseBillingInterval('week')).toBeNull()

	expect(getPriceIdForPlan(env, 'standard')).toBe('price_standard')
	expect(getPriceIdForPlan(env, 'standard', 'month')).toBe('price_standard')
	expect(getPriceIdForPlan(env, 'standard', 'year')).toBe(
		'price_standard_yearly',
	)
	expect(getPriceIdForPlan(env, 'pro', 'month')).toBe('price_pro')
	expect(getPriceIdForPlan(env, 'pro', 'year')).toBe('price_pro_yearly')
	expect(getPriceIdForPlan({}, 'standard', 'year')).toBeNull()
})
