import { expect, test } from 'vitest'
import {
	createBillingLinkReference,
	getBillingPortalConfigurationId,
	getMatchingPriceIdsForPlan,
	getPriceIdForPlan,
	getPurchasablePlans,
	parseBillingInterval,
	resolveSubscriptionPlan,
	selectPlanRetainingSubscriptions,
	subscriptionHasPrice,
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
		stripeInterval: null,
		stripePriceId: null,
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
		stripeInterval: 'month',
		stripePriceId: 'price_standard',
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
		stripeInterval: 'month',
		stripePriceId: 'price_pro',
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
		stripeInterval: 'month',
		stripePriceId: 'price_pro',
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
		stripeInterval: null,
		stripePriceId: null,
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	// Retired plan names in metadata do not override configured price ids.
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
		stripeInterval: 'month',
		stripePriceId: 'price_standard',
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
		stripeInterval: null,
		stripePriceId: null,
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
		stripeInterval: 'month',
		stripePriceId: 'price_pro',
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
		stripePlan: 'pro',
		stripeInterval: 'month',
		stripePriceId: 'price_pro',
		cancelAt: null,
		subscriptionStatus: 'past_due',
	})

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'unpaid',
					priceIds: ['price_pro'],
				}),
			],
			env,
		),
	).toEqual({
		stripePlan: null,
		stripeInterval: null,
		stripePriceId: null,
		cancelAt: null,
		subscriptionStatus: 'unpaid',
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
		stripeInterval: 'year',
		stripePriceId: 'price_standard_yearly',
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
		stripeInterval: 'year',
		stripePriceId: 'price_pro_yearly',
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	expect(getPurchasablePlans(env)).toEqual(['standard', 'pro'])
	expect(getPurchasablePlans({})).toEqual([])

	expect(parseBillingInterval(undefined)).toBe('month')
	expect(parseBillingInterval(null)).toBe('month')
	expect(parseBillingInterval('')).toBe('month')
	expect(parseBillingInterval('weekly')).toBeNull()

	expect(getPriceIdForPlan(env, 'standard')).toBe('price_standard')
	expect(getPriceIdForPlan(env, 'standard', 'year')).toBe(
		'price_standard_yearly',
	)
	expect(getPriceIdForPlan(env, 'pro', 'year')).toBe('price_pro_yearly')
	expect(getPriceIdForPlan({}, 'standard', 'year')).toBeNull()
})

test('resolveSubscriptionPlan reports the interval of the subscription that granted the plan', () => {
	const env = {
		STRIPE_STANDARD_PRICE_ID: 'price_standard',
		STRIPE_STANDARD_YEARLY_PRICE_ID: 'price_standard_yearly',
		STRIPE_PRO_PRICE_ID: 'price_pro',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
	}

	// Legacy double subscription: the higher plan's interval wins, and a
	// lower-ranked sibling does not overwrite it.
	expect(
		resolveSubscriptionPlan(
			[
				subscription({ status: 'active', priceIds: ['price_standard'] }),
				subscription({ status: 'active', priceIds: ['price_pro_yearly'] }),
			],
			env,
		),
	).toMatchObject({
		stripePlan: 'pro',
		stripeInterval: 'year',
		stripePriceId: 'price_pro_yearly',
	})
	expect(
		resolveSubscriptionPlan(
			[
				subscription({ status: 'active', priceIds: ['price_pro_yearly'] }),
				subscription({ status: 'active', priceIds: ['price_standard'] }),
			],
			env,
		),
	).toMatchObject({
		stripePlan: 'pro',
		stripeInterval: 'year',
		stripePriceId: 'price_pro_yearly',
	})
})

test('selectPlanRetainingSubscriptions and subscriptionHasPrice drive the checkout guard', () => {
	const active = subscription({
		id: 'sub_active',
		status: 'active',
		priceIds: ['price_standard'],
	})
	const pastDue = subscription({
		id: 'sub_past_due',
		status: 'past_due',
		priceIds: ['price_pro'],
	})
	const trialing = subscription({ id: 'sub_trial', status: 'trialing' })
	expect(
		selectPlanRetainingSubscriptions([
			subscription({ id: 'sub_canceled', status: 'canceled' }),
			active,
			subscription({ id: 'sub_unpaid', status: 'unpaid' }),
			pastDue,
			subscription({ id: 'sub_incomplete', status: 'incomplete' }),
			trialing,
		]).map((entry) => entry.id),
	).toEqual(['sub_active', 'sub_past_due', 'sub_trial'])

	expect(subscriptionHasPrice(active, 'price_standard')).toBe(true)
	expect(subscriptionHasPrice(active, 'price_standard_yearly')).toBe(false)
	expect(subscriptionHasPrice(trialing, 'price_standard')).toBe(false)

	expect(getBillingPortalConfigurationId({})).toBeNull()
	expect(
		getBillingPortalConfigurationId({
			STRIPE_BILLING_PORTAL_CONFIGURATION_ID: '  ',
		}),
	).toBeNull()
	expect(
		getBillingPortalConfigurationId({
			STRIPE_BILLING_PORTAL_CONFIGURATION_ID: ' bpc_kody ',
		}),
	).toBe('bpc_kody')
})

test('resolveSubscriptionPlan maps retired Pro list prices after checkout ids rotate', () => {
	const env = {
		STRIPE_PRO_PRICE_ID: 'price_pro_current',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly_current',
	}

	// Retired prices resolve the plan but not a configured interval.
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_1U3sg6LAQpAnsYszlVpEIFGx'],
				}),
			],
			env,
		),
	).toMatchObject({
		stripePlan: 'pro',
		stripeInterval: null,
		stripePriceId: 'price_1U3sg6LAQpAnsYszlVpEIFGx',
	})
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_1U3sg7LAQpAnsYszpozAEFUi'],
				}),
			],
			env,
		).stripePlan,
	).toBe('pro')
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_1U1AISLAQpAnsYszIQvRJNhl'],
				}),
			],
			env,
		).stripePlan,
	).toBe('pro')
})

test('resolveSubscriptionPlan maps public $49 and $480 Pro checkout prices', () => {
	const env = {
		STRIPE_PRO_PRICE_ID: 'price_1UChg1LAQpAnsYszAYn6eGgt',
		STRIPE_PRO_YEARLY_PRICE_ID: 'price_1UChg2LAQpAnsYszKAFCR778',
	}

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_1UChg1LAQpAnsYszAYn6eGgt'],
				}),
			],
			env,
		),
	).toMatchObject({
		stripePlan: 'pro',
		stripeInterval: 'month',
		stripePriceId: 'price_1UChg1LAQpAnsYszAYn6eGgt',
	})
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_1UChg2LAQpAnsYszKAFCR778'],
				}),
			],
			env,
		),
	).toMatchObject({
		stripePlan: 'pro',
		stripeInterval: 'year',
		stripePriceId: 'price_1UChg2LAQpAnsYszKAFCR778',
	})
	expect(getMatchingPriceIdsForPlan(env, 'pro').sort()).toEqual(
		[
			'price_1UChg1LAQpAnsYszAYn6eGgt',
			'price_1UChg2LAQpAnsYszKAFCR778',
			'price_1U1AISLAQpAnsYszIQvRJNhl',
			'price_1U3sg6LAQpAnsYszlVpEIFGx',
			'price_1U3sg7LAQpAnsYszpozAEFUi',
		].sort(),
	)
})
