import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { type AccountBillingLoaderData } from '#universal/loader-data.ts'
import {
	describeSeatPricing,
	isRetiredPaidSubscription,
	renderAccountBillingPlans,
	resolveActiveStripePlan,
} from './account-billing-plans.tsx'

function billing(
	overrides: Partial<AccountBillingLoaderData> = {},
): AccountBillingLoaderData {
	return {
		ok: true,
		configured: true,
		manualPlan: 'free',
		stripePlan: null,
		stripeInterval: null,
		effectivePlan: 'free',
		hasStripeCustomer: false,
		cancelAt: null,
		subscriptionStatus: null,
		purchasablePlans: ['pro'],
		creditsEligible: false,
		creditsHref: '/account/usage#credits',
		usageHref: '/account/usage',
		referralProgram: null,
		org: {
			slug: 'ada',
			displayName: null,
			personal: true,
			seats: 1,
			canManage: true,
		},
		...overrides,
	}
}

async function renderPlans(
	data: AccountBillingLoaderData,
	options: { checkoutError?: string } = {},
) {
	return renderToString(
		renderAccountBillingPlans({
			billing: data,
			activeStripePlan: resolveActiveStripePlan(data),
			paymentActionNeeded: false,
			checkoutPending: null,
			selectedIntervalByPlan: { pro: 'month' },
			promoCode: '',
			checkoutError: options.checkoutError ?? null,
			onIntervalChange: () => {},
			onPromoCodeChange: () => {},
			onStartCheckout: () => {},
		}),
	)
}

test('only Free and the $12 Pro are offered', async () => {
	const html = await renderPlans(billing())
	expect(html).toContain('$12/month')
	expect(html).toContain('$120/year')
	expect(html).toContain('Subscribe monthly')
	expect(html).not.toContain('Standard')
	expect(html).not.toContain('$49')
	expect(html).not.toMatch(/\bMax\b/)
})

test('retired Standard and $49 Pro subscribers get a prorated switch to Pro', async () => {
	const retiredStandard = billing({
		stripePlan: 'standard',
		effectivePlan: 'standard',
		hasStripeCustomer: true,
	})
	const retiredPro = billing({
		stripePlan: 'pro',
		effectivePlan: 'pro',
		hasStripeCustomer: true,
	})
	for (const data of [retiredStandard, retiredPro]) {
		expect(isRetiredPaidSubscription(data)).toBe(true)
		const html = await renderPlans(data)
		expect(html).toContain('Switch to Pro (prorated)')
		expect(html).not.toContain('Current plan')
	}
})

test('purchasable Pro subscribers see their plan and the interval switch', async () => {
	const data = billing({
		stripePlan: 'pro',
		effectivePlan: 'pro',
		stripeInterval: 'month',
		hasStripeCustomer: true,
		creditsEligible: true,
	})
	expect(isRetiredPaidSubscription(data)).toBe(false)
	const html = await renderPlans(data)
	expect(html).toContain('Current plan')
	expect(html).toContain('Switch to annual (prorated)')
	expect(html).not.toContain('Switch to Pro')
})

test('team organizations see seat pricing and a promo field; non-managers see no actions', async () => {
	const team = billing({
		creditsHref: null,
		usageHref: null,
		org: {
			slug: 'acme',
			displayName: 'Acme',
			personal: false,
			seats: 3,
			canManage: true,
		},
	})
	const html = await renderPlans(team)
	expect(html).toContain('3 seats · $36/month')
	expect(html).toContain('Promo code (optional)')
	expect(html).toContain('Subscribe monthly')
	expect(html).not.toContain('See your current usage')

	const readOnly = await renderPlans(
		billing({ ...team, org: { ...team.org, canManage: false } }),
	)
	expect(readOnly).toContain('3 seats · $36/month')
	expect(readOnly).not.toContain('Subscribe monthly')
	expect(readOnly).not.toContain('Promo code')
})

test('seat pricing multiplies the per-seat Pro price by live seats', () => {
	expect(describeSeatPricing(1, 'month')).toBe('1 seat · $12/month')
	expect(describeSeatPricing(3, 'month')).toBe('3 seats · $36/month')
	expect(describeSeatPricing(3, 'year')).toBe('3 seats · $360/year')
})

test('a rejected checkout explains itself under the Subscribe button', async () => {
	const error =
		'Promo codes apply to monthly billing only. Choose monthly to use this code.'
	const html = await renderPlans(billing(), { checkoutError: error })
	const button = html.indexOf('Subscribe monthly')
	const alert = html.indexOf('role="alert"')
	expect(button).toBeGreaterThan(-1)
	expect(alert).toBeGreaterThan(button)
	expect(html.slice(alert)).toContain(error)
	expect(await renderPlans(billing())).not.toContain('role="alert"')
})

test('an annual team subscription shows its annual seat total', async () => {
	const team = {
		slug: 'acme',
		displayName: 'Acme',
		personal: false,
		seats: 3,
		canManage: true,
	}
	const annual = await renderPlans(
		billing({
			stripePlan: 'pro',
			stripeInterval: 'year',
			effectivePlan: 'pro',
			hasStripeCustomer: true,
			creditsEligible: true,
			org: team,
		}),
	)
	expect(annual).toContain('3 seats · $360/year')
	expect(annual).not.toContain('3 seats · $36/month')
	expect(await renderPlans(billing({ org: team }))).toContain(
		'3 seats · $36/month',
	)
})
