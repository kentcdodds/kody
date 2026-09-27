import { expect, test } from 'vitest'
import {
	createBillingLinkReference,
	getBillingPortalConfigurationId,
	getMatchingPriceIdsForPlan,
	getPriceIdForPlan,
	getPurchasablePlans,
	isCreditsEligiblePriceId,
	parseBillingInterval,
	retiredProPriceIds,
	retiredStandardPriceIds,
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

const env = {
	STRIPE_PRO_PRICE_ID: 'price_pro',
	STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly',
}
const retiredStandardMonthly = 'price_1U3sg6LAQpAnsYszGeL2nc8O'
const retiredStandardYearly = 'price_1U3sg6LAQpAnsYszqq9abwIY'
const retiredProMonthly = 'price_1UChg1LAQpAnsYszAYn6eGgt'
const retiredProYearly = 'price_1UChg2LAQpAnsYszKAFCR778'

test('resolveSubscriptionPlan maps active price and metadata plans with soonest cancel_at', () => {
	expect(
		resolveSubscriptionPlan(
			[
				subscription({ status: 'canceled', priceIds: ['price_pro'] }),
				subscription({ status: 'incomplete', priceIds: ['price_pro'] }),
			],
			env,
		),
	).toEqual({
		stripePlan: null,
		creditsEligible: false,
		stripeInterval: null,
		stripePriceId: null,
		cancelAt: null,
		subscriptionStatus: 'incomplete',
	})

	expect(
		resolveSubscriptionPlan(
			[subscription({ status: 'trialing', priceIds: ['price_pro'] })],
			env,
		),
	).toEqual({
		stripePlan: 'pro',
		creditsEligible: true,
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
		creditsEligible: false,
		stripeInterval: null,
		stripePriceId: null,
		cancelAt: null,
		subscriptionStatus: 'active',
	})

	// Retired plan names in metadata do not override known price ids.
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: [retiredStandardMonthly],
					metadata: { kody_plan: 'partner' },
				}),
			],
			env,
		),
	).toMatchObject({ stripePlan: 'standard', creditsEligible: false })

	expect(
		resolveSubscriptionPlan(
			[subscription({ status: 'active', priceIds: ['price_unknown'] })],
			env,
		),
	).toMatchObject({ stripePlan: null, creditsEligible: false })

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
	).toMatchObject({
		stripePlan: 'pro',
		creditsEligible: true,
		cancelAt: new Date(sooner * 1000).toISOString(),
		subscriptionStatus: 'active',
	})

	expect(
		resolveSubscriptionPlan(
			[subscription({ status: 'past_due', priceIds: ['price_pro'] })],
			env,
		),
	).toMatchObject({ stripePlan: 'pro', subscriptionStatus: 'past_due' })

	expect(
		resolveSubscriptionPlan(
			[subscription({ status: 'unpaid', priceIds: ['price_pro'] })],
			env,
		),
	).toMatchObject({ stripePlan: null, creditsEligible: false })

	expect(
		resolveSubscriptionPlan(
			[subscription({ status: 'active', priceIds: ['price_pro_yearly'] })],
			env,
		),
	).toMatchObject({
		stripePlan: 'pro',
		creditsEligible: true,
		stripeInterval: 'year',
		stripePriceId: 'price_pro_yearly',
	})

	expect(getPurchasablePlans(env)).toEqual(['pro'])
	expect(getPurchasablePlans({})).toEqual([])

	expect(parseBillingInterval(undefined)).toBe('month')
	expect(parseBillingInterval(null)).toBe('month')
	expect(parseBillingInterval('')).toBe('month')
	expect(parseBillingInterval('weekly')).toBeNull()

	expect(getPriceIdForPlan(env, 'pro')).toBe('price_pro')
	expect(getPriceIdForPlan(env, 'pro', 'year')).toBe('price_pro_yearly')
	expect(getPriceIdForPlan({}, 'pro', 'year')).toBeNull()
})

test('credit wallet eligibility keys off the purchasable Pro price, not plan or list price', () => {
	expect(isCreditsEligiblePriceId(env, 'price_pro')).toBe(true)
	expect(isCreditsEligiblePriceId(env, ' price_pro_yearly ')).toBe(true)
	expect(isCreditsEligiblePriceId(env, retiredStandardMonthly)).toBe(false)
	expect(isCreditsEligiblePriceId(env, retiredProMonthly)).toBe(false)
	expect(isCreditsEligiblePriceId(env, null)).toBe(false)
	expect(isCreditsEligiblePriceId({}, 'price_pro')).toBe(false)

	// Retired Standard at the same $12 list price: plan kept, no wallet.
	expect(
		resolveSubscriptionPlan(
			[subscription({ status: 'active', priceIds: [retiredStandardMonthly] })],
			env,
		),
	).toEqual({
		stripePlan: 'standard',
		creditsEligible: false,
		stripeInterval: null,
		stripePriceId: retiredStandardMonthly,
		cancelAt: null,
		subscriptionStatus: 'active',
	})
	expect(
		resolveSubscriptionPlan(
			[subscription({ status: 'active', priceIds: [retiredStandardYearly] })],
			env,
		),
	).toMatchObject({ stripePlan: 'standard', creditsEligible: false })
	// Retired $49 / $480 Pro: plan kept, no wallet.
	for (const priceId of [retiredProMonthly, retiredProYearly]) {
		expect(
			resolveSubscriptionPlan(
				[subscription({ status: 'active', priceIds: [priceId] })],
				env,
			),
		).toMatchObject({
			stripePlan: 'pro',
			creditsEligible: false,
			stripeInterval: null,
			stripePriceId: priceId,
		})
	}
	// A retired Pro beside the purchasable Pro surfaces the wallet.
	expect(
		resolveSubscriptionPlan(
			[
				subscription({ status: 'active', priceIds: [retiredProMonthly] }),
				subscription({ status: 'active', priceIds: ['price_pro'] }),
			],
			env,
		),
	).toMatchObject({
		stripePlan: 'pro',
		creditsEligible: true,
		stripePriceId: 'price_pro',
	})
})

test('resolveSubscriptionPlan reports the interval of the subscription that granted the plan', () => {
	expect(
		resolveSubscriptionPlan(
			[
				subscription({ status: 'active', priceIds: [retiredStandardMonthly] }),
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
				subscription({ status: 'active', priceIds: [retiredStandardMonthly] }),
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
		priceIds: [retiredStandardMonthly],
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

	expect(subscriptionHasPrice(active, retiredStandardMonthly)).toBe(true)
	expect(subscriptionHasPrice(active, 'price_pro')).toBe(false)
	expect(subscriptionHasPrice(trialing, retiredStandardMonthly)).toBe(false)

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

test('retired Standard and Pro price ids keep resolving their plans', () => {
	expect(getMatchingPriceIdsForPlan(env, 'standard').sort()).toEqual(
		[...retiredStandardPriceIds].sort(),
	)
	expect(getMatchingPriceIdsForPlan(env, 'pro').sort()).toEqual(
		['price_pro', 'price_pro_yearly', ...retiredProPriceIds].sort(),
	)
	for (const priceId of [
		'price_1U3sg6LAQpAnsYszlVpEIFGx',
		'price_1U3sg7LAQpAnsYszpozAEFUi',
		'price_1U1AISLAQpAnsYszIQvRJNhl',
	]) {
		expect(
			resolveSubscriptionPlan(
				[subscription({ status: 'active', priceIds: [priceId] })],
				env,
			),
		).toMatchObject({ stripePlan: 'pro', creditsEligible: false })
	}
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
	).toMatchObject({ stripePlan: 'standard', creditsEligible: false })
})
