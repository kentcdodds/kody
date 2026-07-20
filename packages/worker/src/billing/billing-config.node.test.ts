import { expect, test } from 'vitest'
import {
	buildPaymentLinkUrl,
	createBillingLinkReference,
	isBillingConfigured,
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

test('isBillingConfigured requires a non-empty STRIPE_SECRET_KEY', () => {
	expect(isBillingConfigured({})).toBe(false)
	expect(isBillingConfigured({ STRIPE_SECRET_KEY: '' })).toBe(false)
	expect(isBillingConfigured({ STRIPE_SECRET_KEY: '   ' })).toBe(false)
	expect(isBillingConfigured({ STRIPE_SECRET_KEY: 'sk_test_123' })).toBe(true)
})

test('buildPaymentLinkUrl appends client_reference_id and prefilled_email', () => {
	const url = buildPaymentLinkUrl({
		baseUrl: 'https://buy.stripe.com/test_pro',
		clientReferenceId: 'signedref123',
		email: 'user@example.com',
	})
	const parsed = new URL(url)
	expect(parsed.origin + parsed.pathname).toBe(
		'https://buy.stripe.com/test_pro',
	)
	expect(parsed.searchParams.get('client_reference_id')).toBe('signedref123')
	expect(parsed.searchParams.get('prefilled_email')).toBe('user@example.com')
})

test('buildPaymentLinkUrl preserves existing query params on the payment link', () => {
	const url = buildPaymentLinkUrl({
		baseUrl: 'https://buy.stripe.com/test?locale=en',
		clientReferenceId: 'ref',
		email: 'a@b.com',
	})
	const parsed = new URL(url)
	expect(parsed.searchParams.get('locale')).toBe('en')
	expect(parsed.searchParams.get('client_reference_id')).toBe('ref')
	expect(parsed.searchParams.get('prefilled_email')).toBe('a@b.com')
})

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

test('resolveSubscriptionPlan ignores non-active statuses', () => {
	const env = {
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
	).toEqual({ stripePlan: null, cancelAt: null })
})

test('resolveSubscriptionPlan matches the pro price id', () => {
	const env = {
		STRIPE_PRO_PRICE_ID: 'price_pro',
	}
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
	).toEqual({ stripePlan: 'pro', cancelAt: null })

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
	).toEqual({ stripePlan: 'pro', cancelAt: null })
})

test('resolveSubscriptionPlan falls back to kody_plan metadata when prices do not match', () => {
	const env = {
		STRIPE_PRO_PRICE_ID: 'price_pro',
	}
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
	).toEqual({ stripePlan: 'pro', cancelAt: null })

	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_other'],
					metadata: { kody_plan: 'enterprise' },
				}),
			],
			env,
		),
	).toEqual({ stripePlan: null, cancelAt: null })
})

test('resolveSubscriptionPlan returns the soonest cancel_at as ISO', () => {
	const env = {
		STRIPE_PRO_PRICE_ID: 'price_pro',
	}
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
	})
})

test('resolveSubscriptionPlan ignores unknown price ids without metadata', () => {
	expect(
		resolveSubscriptionPlan(
			[
				subscription({
					status: 'active',
					priceIds: ['price_unknown'],
				}),
			],
			{
				STRIPE_PRO_PRICE_ID: 'price_pro',
			},
		),
	).toEqual({ stripePlan: null, cancelAt: null })
})
