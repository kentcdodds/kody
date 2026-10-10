import {
	planLimits,
	proCreditsPlanLimits,
	resolvePlanLimits,
	type PlanLimits,
} from './plans.ts'

export type PricingLimitColumn = {
	id: 'free' | 'pro' | 'pro-credits'
	plan: string
	price: string
	priceNote?: string
	limits: PlanLimits
}

/**
 * The plans a visitor can sign up for, each with the limit table the
 * entitlement service enforces for it. Pro shows its include and, beside it,
 * the ceiling a funded credit wallet runs up to.
 */
export const pricingLimitColumns: ReadonlyArray<PricingLimitColumn> = [
	{ id: 'free', plan: 'Free', price: '$0', limits: planLimits.free },
	{
		id: 'pro',
		plan: 'Pro',
		price: '$12/mo',
		priceNote: 'or $120/yr',
		limits: proCreditsPlanLimits,
	},
	{
		id: 'pro-credits',
		plan: 'Pro + credits',
		price: 'up to',
		limits: resolvePlanLimits('pro', 'public', 'funded'),
	},
]
