import { expect, test } from 'vitest'
import {
	buildPaymentLinkUrl,
	createBillingLinkReference,
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

test('buildPaymentLinkUrl appends checkout params and preserves existing query params', () => {
	const appended = new URL(
		buildPaymentLinkUrl({
			baseUrl: 'https://buy.stripe.com/test_pro',
			clientReferenceId: 'signedref123',
			email: 'user@example.com',
		}),
	)
	expect(appended.origin + appended.pathname).toBe(
		'https://buy.stripe.com/test_pro',
	)
	expect(appended.searchParams.get('client_reference_id')).toBe('signedref123')
	expect(appended.searchParams.get('prefilled_email')).toBe('user@example.com')

	const preserved = new URL(
		buildPaymentLinkUrl({
			baseUrl: 'https://buy.stripe.com/test?locale=en',
			clientReferenceId: 'ref',
			email: 'a@b.com',
		}),
	)
	expect(preserved.searchParams.get('locale')).toBe('en')
	expect(preserved.searchParams.get('client_reference_id')).toBe('ref')
	expect(preserved.searchParams.get('prefilled_email')).toBe('a@b.com')
})

test('resolveSubscriptionPlan maps active price and metadata plans with soonest cancel_at', () => {
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
					priceIds: ['price_unknown'],
				}),
			],
			env,
		),
	).toEqual({ stripePlan: null, cancelAt: null })

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
