import { css, on } from 'remix/ui'
import {
	type AccountBillingLoaderData,
	type AdminPlanName,
} from '#universal/loader-data.ts'
import { AccountManagementPanel } from '#client/routes/account-management-components.tsx'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
	primaryLinkCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

export type PaidTier = 'standard' | 'pro'
type PlanTier = 'free' | PaidTier
export type BillingInterval = 'month' | 'year'
export type CheckoutPending = {
	plan: PaidTier
	interval: BillingInterval
} | null

const proratedSwitchNote =
	'Switching plans is prorated: Stripe shows the exact charge or credit and asks you to confirm before anything changes.'

function describePlanSwitch(input: {
	tier: PaidTier
	interval: BillingInterval
	currentPlan: PaidTier | null
}) {
	if (input.currentPlan === input.tier) {
		return input.interval === 'year'
			? 'Switch to annual (prorated)'
			: 'Switch to monthly (prorated)'
	}
	return `Switch to ${input.tier === 'pro' ? 'Pro' : 'Standard'} (prorated)`
}

const planTiers: Array<{
	id: PlanTier
	name: string
	price: string
	annualPrice?: string
	description: string
}> = [
	{
		id: 'free',
		name: 'Free',
		price: '$0',
		description:
			'Room to build real automations. Capped on daily volume, not on how much you build.',
	},
	{
		id: 'standard',
		name: 'Standard',
		price: '$12/month',
		annualPrice: '$10/mo billed annually',
		description:
			'Higher daily volume and more room for scheduled jobs and workflows.',
	},
	{
		id: 'pro',
		name: 'Pro',
		price: '$49/month',
		annualPrice: '$40/mo billed annually',
		description:
			'For heavy daily automation — more room for storage, jobs, workflows, and daily volume.',
	},
]

/** Mirrors server rank: free < standard < pro < max. */
function getPlanRank(plan: AdminPlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'standard':
			return 1
		case 'pro':
			return 2
		case 'max':
			return 3
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown plan: ${String(exhaustive)}`)
		}
	}
}

function planCoversTier(effectivePlan: AdminPlanName, tier: PlanTier): boolean {
	return getPlanRank(effectivePlan) >= getPlanRank(tier)
}

/**
 * The tier the customer's Stripe subscription is on. Their plan changes are
 * prorated updates to that subscription (confirmed in the portal), not new
 * checkouts, so the buttons say "Switch" instead of "Subscribe".
 */
export function resolveActiveStripePlan(
	billing: AccountBillingLoaderData | null,
): PaidTier | null {
	return billing?.hasStripeCustomer &&
		(billing.stripePlan === 'standard' || billing.stripePlan === 'pro')
		? billing.stripePlan
		: null
}

export function renderAccountBillingPlans(input: {
	billing: AccountBillingLoaderData
	activeStripePlan: PaidTier | null
	paymentActionNeeded: boolean
	checkoutPending: CheckoutPending
	selectedIntervalByPlan: Record<PaidTier, BillingInterval>
	onIntervalChange: (plan: PaidTier, interval: BillingInterval) => void
	onStartCheckout: (plan: PaidTier, interval: BillingInterval) => void
}) {
	const {
		billing,
		activeStripePlan,
		paymentActionNeeded,
		checkoutPending,
		selectedIntervalByPlan,
	} = input
	return (
		<AccountManagementPanel
			title="Plans"
			description="Choose a plan that fits how you use Kody."
		>
			<div
				mix={css({
					display: 'grid',
					gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
					gap: spacing.md,
					[mq.mobile]: {
						gridTemplateColumns: '1fr',
					},
				})}
			>
				{planTiers.map((tier) => {
					const isCurrent = billing.effectivePlan === tier.id
					const isIncluded =
						!isCurrent && planCoversTier(billing.effectivePlan, tier.id)
					const paidTier: PaidTier | null = tier.id === 'free' ? null : tier.id
					const purchasable =
						paidTier != null &&
						billing.purchasablePlans.includes(paidTier) &&
						!paymentActionNeeded
					const showSubscribe = purchasable && !isCurrent && !isIncluded
					// The tier the Stripe subscription is on: offer the other
					// billing interval when the current one is known.
					const intervalSwitch: BillingInterval | null =
						purchasable &&
						paidTier === activeStripePlan &&
						billing.stripeInterval != null
							? billing.stripeInterval === 'month'
								? 'year'
								: 'month'
							: null

					return (
						<div
							key={tier.id}
							mix={css({
								display: 'grid',
								gap: spacing.sm,
								alignContent: 'start',
								padding: spacing.md,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.background,
							})}
						>
							<strong
								mix={css({
									fontSize: typography.fontSize.base,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								{tier.name}
							</strong>
							<span
								mix={css({
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								})}
							>
								{tier.price}
							</span>
							{tier.annualPrice ? (
								<span
									mix={css({
										fontSize: typography.fontSize.sm,
										color: colors.textMuted,
									})}
								>
									{tier.annualPrice}
								</span>
							) : null}
							<p mix={css(descriptionCss)}>{tier.description}</p>
							<p mix={css({ margin: 0 })}>
								<a href="/account/usage" mix={css(primaryLinkCss)}>
									See your current usage
								</a>
							</p>
							{intervalSwitch && paidTier ? (
								<div
									mix={css({
										display: 'flex',
										flexWrap: 'wrap',
										gap: spacing.sm,
									})}
								>
									<button type="button" disabled mix={css(secondaryButtonCss)}>
										{isCurrent ? 'Current plan' : 'Your subscription'}
									</button>
									<button
										type="button"
										disabled={checkoutPending !== null}
										mix={[
											on('click', () =>
												input.onStartCheckout(paidTier, intervalSwitch),
											),
											css(primaryButtonCss),
										]}
									>
										{checkoutPending?.plan === paidTier
											? 'Opening Stripe…'
											: describePlanSwitch({
													tier: paidTier,
													interval: intervalSwitch,
													currentPlan: activeStripePlan,
												})}
									</button>
								</div>
							) : isCurrent || isIncluded ? (
								<div>
									<button type="button" disabled mix={css(secondaryButtonCss)}>
										{isCurrent ? 'Current plan' : 'Included in your plan'}
									</button>
								</div>
							) : showSubscribe && paidTier ? (
								<div
									mix={css({
										display: 'grid',
										gap: spacing.sm,
									})}
								>
									<fieldset
										mix={css({
											margin: 0,
											padding: 0,
											border: 'none',
											display: 'grid',
											gap: spacing.xs,
										})}
									>
										<legend mix={css(visuallyHiddenCss)}>
											{tier.name} billing interval
										</legend>
										<label
											mix={css({
												display: 'flex',
												gap: spacing.sm,
												alignItems: 'center',
											})}
										>
											<input
												type="radio"
												name={`${paidTier}-interval`}
												checked={selectedIntervalByPlan[paidTier] === 'month'}
												mix={[
													on('change', () =>
														input.onIntervalChange(paidTier, 'month'),
													),
												]}
											/>
											<span>Monthly</span>
										</label>
										<label
											mix={css({
												display: 'flex',
												gap: spacing.sm,
												alignItems: 'center',
											})}
										>
											<input
												type="radio"
												name={`${paidTier}-interval`}
												checked={selectedIntervalByPlan[paidTier] === 'year'}
												mix={[
													on('change', () =>
														input.onIntervalChange(paidTier, 'year'),
													),
												]}
											/>
											<span>Annual</span>
										</label>
									</fieldset>
									<div>
										<button
											type="button"
											disabled={checkoutPending !== null}
											mix={[
												on('click', () =>
													input.onStartCheckout(
														paidTier,
														selectedIntervalByPlan[paidTier],
													),
												),
												css(primaryButtonCss),
											]}
										>
											{checkoutPending?.plan === paidTier
												? activeStripePlan
													? 'Opening Stripe…'
													: 'Starting checkout…'
												: activeStripePlan
													? describePlanSwitch({
															tier: paidTier,
															interval: selectedIntervalByPlan[paidTier],
															currentPlan: activeStripePlan,
														})
													: selectedIntervalByPlan[paidTier] === 'year'
														? 'Subscribe annually'
														: 'Subscribe monthly'}
										</button>
									</div>
								</div>
							) : null}
						</div>
					)
				})}
			</div>
			{activeStripePlan && !paymentActionNeeded ? (
				<p mix={css(descriptionCss)}>{proratedSwitchNote}</p>
			) : null}
		</AccountManagementPanel>
	)
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
