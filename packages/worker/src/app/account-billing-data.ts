import { type AccountBillingLoaderData } from '#app/loader-data.ts'
import {
	getProPriceId,
	isBillingConfigured,
} from '#worker/billing/billing-config.ts'
import { refreshStripePlanForUser } from '#worker/billing/subscription-sync.ts'
import {
	parsePlanName,
	parseStripePlanName,
	resolveEffectivePlan,
	type PlanName,
} from '#worker/entitlements/plans.ts'

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

type BillingUserRow = {
	plan: string | null
	stripe_plan: string | null
	stripe_customer_id: string | null
	stripe_plan_refreshed_at: string | null
}

export async function loadAccountBillingData(input: {
	env: Env
	userId: number
	errorCode?: string | null
	now?: Date
}): Promise<AccountBillingLoaderData> {
	const now = input.now ?? new Date()
	const configured = isBillingConfigured(input.env)
	const error = resolveBillingErrorMessage(input.errorCode)

	const row = await input.env.APP_DB.prepare(
		`SELECT plan, stripe_plan, stripe_customer_id, stripe_plan_refreshed_at
		 FROM users
		 WHERE id = ?`,
	)
		.bind(input.userId)
		.first<BillingUserRow>()

	const manualPlan: PlanName | null = parsePlanName(row?.plan)
	let stripePlan: PlanName | null = parseStripePlanName(row?.stripe_plan)
	let cancelAt: string | null = null
	const customerId = row?.stripe_customer_id?.trim() || null
	const hasStripeCustomer = Boolean(customerId)

	if (configured && customerId) {
		// Always refresh on page view: cancel_at is not persisted, so serving
		// the stored stripe_plan would hide a scheduled cancellation. Billing
		// page loads are rare enough that one Stripe call per view is fine;
		// failures fall back to the stored plan.
		try {
			const refreshed = await refreshStripePlanForUser({
				env: input.env,
				userId: input.userId,
				customerId,
				now,
			})
			stripePlan = refreshed.stripePlan
			cancelAt = refreshed.cancelAt
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

	const checkoutAvailable = configured && Boolean(getProPriceId(input.env))

	return {
		ok: true,
		configured,
		manualPlan,
		stripePlan,
		effectivePlan: resolveEffectivePlan(manualPlan, stripePlan),
		hasStripeCustomer,
		cancelAt,
		checkoutAvailable,
		...(error ? { error } : {}),
	}
}
