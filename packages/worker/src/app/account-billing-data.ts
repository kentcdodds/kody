import { type AccountBillingLoaderData } from '#universal/loader-data.ts'
import {
	getPurchasablePlans,
	isBillingConfigured,
	type BillingInterval,
} from '#worker/billing/billing-config.ts'
import { scheduleStripePlanRefreshBackstop } from '#worker/billing/stripe-plan-refresh-client.ts'
import { refreshStripePlanForUser } from '#worker/billing/subscription-sync.ts'
import {
	parseStoredPlanName,
	parseStripePlanName,
	resolveEffectivePlan,
	type PlanName,
} from '#universal/plans.ts'

const billingErrorMessages: Record<string, string> = {
	billing_not_configured: 'Billing is not configured on this deployment.',
	no_customer:
		'No Stripe customer is linked to this account yet. Subscribe first, then manage billing.',
	missing_session: 'Checkout session id is missing.',
	client_reference_mismatch:
		'That checkout session does not belong to your account.',
	missing_customer: 'The checkout session did not include a Stripe customer.',
	customer_already_linked:
		'This Stripe customer is already linked to another Kody account.',
	account_already_linked:
		'Your account is already linked to a different Stripe customer. Contact the operator to relink it.',
	link_failed: 'Unable to link the Stripe checkout session.',
	stripe_error: 'Unable to reach Stripe right now. Try again shortly.',
	portal_failed: 'Unable to open the Stripe billing portal.',
}

export function resolveBillingErrorMessage(
	errorCode: string | null | undefined,
): string | undefined {
	const trimmed = errorCode?.trim()
	if (!trimmed) return undefined
	return billingErrorMessages[trimmed] ?? trimmed
}

/**
 * `?billing=<code>` success notices. The Stripe portal's subscription-update
 * flow redirects back with `billing=updated`; unknown codes render nothing
 * (unlike error codes, which fall back to the raw code).
 */
const billingNoticeMessages: Record<string, string> = {
	updated: 'Your plan change is complete. Limits update within a minute.',
}

export function resolveBillingNoticeMessage(
	noticeCode: string | null | undefined,
): string | undefined {
	const trimmed = noticeCode?.trim()
	if (!trimmed) return undefined
	return billingNoticeMessages[trimmed]
}

type BillingUserRow = {
	plan: string
	stripe_plan: string | null
	stripe_customer_id: string | null
	stripe_plan_refreshed_at: string | null
	stable_user_id: string
}

export async function loadAccountBillingData(input: {
	env: Env
	userId: number
	errorCode?: string | null
	noticeCode?: string | null
	now?: Date
}): Promise<AccountBillingLoaderData> {
	const now = input.now ?? new Date()
	const configured = isBillingConfigured(input.env)
	const error = resolveBillingErrorMessage(input.errorCode)
	const notice = resolveBillingNoticeMessage(input.noticeCode)

	const row = await input.env.APP_DB.prepare(
		`SELECT plan, stripe_plan, stripe_customer_id, stripe_plan_refreshed_at,
		        stable_user_id
		 FROM users
		 WHERE id = ?`,
	)
		.bind(input.userId)
		.first<BillingUserRow>()

	const manualPlan: PlanName = row ? parseStoredPlanName(row.plan) : 'max'
	let stripePlan: PlanName | null = parseStripePlanName(row?.stripe_plan)
	let stripeInterval: BillingInterval | null = null
	let cancelAt: string | null = null
	let subscriptionStatus: string | null = null
	const customerId = row?.stripe_customer_id?.trim() || null
	const hasStripeCustomer = Boolean(customerId)

	if (configured && customerId) {
		if (row?.stable_user_id) {
			await scheduleStripePlanRefreshBackstop({
				env: input.env,
				userId: row.stable_user_id,
				now,
			})
		}
		// Always refresh on page view: cancel_at and subscriptionStatus are not
		// persisted, so serving the stored stripe_plan would hide a scheduled
		// cancellation or past_due state. Billing page loads are rare enough
		// that one Stripe call per view is fine; failures fall back to the
		// stored plan with null status.
		try {
			const refreshed = await refreshStripePlanForUser({
				env: input.env,
				userId: input.userId,
				customerId,
				now,
			})
			stripePlan = refreshed.stripePlan
			stripeInterval = refreshed.stripeInterval
			cancelAt = refreshed.cancelAt
			subscriptionStatus = refreshed.subscriptionStatus
		} catch (refreshError) {
			console.error('account_billing_refresh_failed', {
				userId: input.userId,
				error:
					refreshError instanceof Error
						? refreshError.message
						: String(refreshError),
			})
		}
	}

	const purchasablePlans = configured ? getPurchasablePlans(input.env) : []

	return {
		ok: true,
		configured,
		manualPlan,
		stripePlan,
		stripeInterval,
		effectivePlan: resolveEffectivePlan(manualPlan, stripePlan),
		hasStripeCustomer,
		cancelAt,
		subscriptionStatus,
		purchasablePlans,
		usageHref: '/account/usage',
		...(error ? { error } : {}),
		...(notice ? { notice } : {}),
	}
}
