import { type AdminPlanName } from '#app/loader-data.ts'

/**
 * True when an admin grant is a deliberate non-free override that does not
 * match the Stripe subscription. Ordinary subscribers keep `users.plan =
 * 'free'` with their paid tier only on `stripe_plan`; that is not a split.
 */
export function adminGrantDiffersFromSubscription(
	manualPlan: AdminPlanName,
	stripePlan: AdminPlanName | null,
) {
	return manualPlan !== 'free' && stripePlan !== manualPlan
}
