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
	/**
	 * Monthly compute meters keep running past the include and debit credits,
	 * so their value is an include, not a ceiling.
	 */
	chargesPastInclude?: true
	/**
	 * Monthly compute meters are informational (no wallet): they never
	 * charge or stop runs, so their value is a guideline, not a cap.
	 */
	monthlyIncludeIsGuideline?: true
}

/**
 * The plans a visitor can sign up for, each with the limit table the
 * entitlement service enforces for it. Pro shows its include and, beside it,
 * the ceiling a funded credit wallet runs up to.
 */
export const pricingLimitColumns: ReadonlyArray<PricingLimitColumn> = [
	{
		id: 'free',
		plan: 'Free',
		price: '$0',
		limits: planLimits.free,
		monthlyIncludeIsGuideline: true,
	},
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
		chargesPastInclude: true,
	},
]
