import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { type AccountBillingLoaderData } from '#universal/loader-data.ts'
import {
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
		creditsHref: '/account/credits',
		usageHref: '/account/usage',
		referralProgram: null,
		...overrides,
	}
}

async function renderPlans(data: AccountBillingLoaderData) {
	return renderToString(
		renderAccountBillingPlans({
			billing: data,
			activeStripePlan: resolveActiveStripePlan(data),
			paymentActionNeeded: false,
			checkoutPending: null,
			selectedIntervalByPlan: { pro: 'month' },
			onIntervalChange: () => {},
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
