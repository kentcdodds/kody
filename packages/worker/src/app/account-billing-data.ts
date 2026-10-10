import { accountCreditsPath } from '#universal/compute-overage.ts'
import { type AccountBillingLoaderData } from '#universal/loader-data.ts'
import { getCanonicalAppBaseUrl } from '#worker/app-base-url.ts'
import {
	getPurchasablePlans,
	isBillingConfigured,
	type BillingInterval,
} from '#worker/billing/billing-config.ts'
import { scheduleStripePlanRefreshBackstop } from '#worker/billing/stripe-plan-refresh-client.ts'
import {
	refreshStripePlanForOrg,
	refreshStripePlanForUser,
} from '#worker/billing/subscription-sync.ts'
import {
	parseStoredPlanName,
	parseStripePlanName,
	type PlanName,
} from '#universal/plans.ts'
import { laterIsoTimestamp } from '#universal/referral-program.ts'
import { resolveEffectivePlanWithSecondAgentGift } from '#universal/second-agent-standard-gift.ts'
import { loadReferralProgramSummary } from '#worker/entitlements/referral-program.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

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
	updated: `Your plan change is complete. Limits update within a minute. Add credits at ${accountCreditsPath}.`,
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
	username: string | null
	stripe_plan: string | null
	stripe_credits_eligible: number | null
	stripe_customer_id: string | null
	stripe_plan_refreshed_at: string | null
	stable_user_id: string
	second_agent_standard_gift_expires_at: string | null
	referral_standard_credit_expires_at: string | null
}

type BillingOrgRow = {
	plan: string
	stripe_plan: string | null
	stripe_credits_eligible: number | null
	stripe_customer_id: string | null
}

/** The organization whose subscription the billing page shows. */
export type BillingPageOrg = {
	id: string
	slug: string
	displayName: string | null
	/** Signup organization: its plan columns live on the person's users row. */
	personal: boolean
}

type PlanState = {
	manualPlan: PlanName
	stripePlan: PlanName | null
	creditsEligible: boolean
	customerId: string | null
	overlayExpiresAt: string | null
	referral: { stableUserId: string; username: string } | null
}

type RefreshedPlan = {
	stripePlan: PlanName | null
	creditsEligible: boolean
	stripeInterval: BillingInterval | null
	cancelAt: string | null
	subscriptionStatus: string | null
}

async function readPersonalPlanState(
	env: Env,
	userId: number,
): Promise<PlanState & { stableUserId: string | null }> {
	const row = await env.APP_DB.prepare(
		`SELECT plan, username, stripe_plan, stripe_credits_eligible,
		        stripe_customer_id, stripe_plan_refreshed_at,
		        stable_user_id, second_agent_standard_gift_expires_at,
		        referral_standard_credit_expires_at
		 FROM users
		 WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(userId)
		.first<BillingUserRow>()
	return {
		manualPlan: row ? parseStoredPlanName(row.plan) : 'max',
		stripePlan: parseStripePlanName(row?.stripe_plan),
		creditsEligible: Number(row?.stripe_credits_eligible) === 1,
		customerId: row?.stripe_customer_id?.trim() || null,
		overlayExpiresAt: laterIsoTimestamp(
			row?.second_agent_standard_gift_expires_at,
			row?.referral_standard_credit_expires_at,
		),
		referral:
			row?.stable_user_id && row.username
				? { stableUserId: row.stable_user_id, username: row.username }
				: null,
		stableUserId: row?.stable_user_id ?? null,
	}
}

async function readTeamPlanState(env: Env, orgId: string): Promise<PlanState> {
	const row = await env.APP_DB.prepare(
		`SELECT plan, stripe_plan, stripe_credits_eligible, stripe_customer_id
		 FROM orgs
		 WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(orgId)
		.first<BillingOrgRow>()
	if (!row) {
		throw new Error(`Cannot load billing: missing org ${orgId}.`)
	}
	return {
		manualPlan: parseStoredPlanName(row.plan),
		stripePlan: parseStripePlanName(row.stripe_plan),
		creditsEligible: Number(row.stripe_credits_eligible) === 1,
		customerId: row.stripe_customer_id?.trim() || null,
		overlayExpiresAt: null,
		referral: null,
	}
}

export async function loadAccountBillingData(input: {
	env: Env
	/** `users.id` of the signed-in person (signup-organization plan columns). */
	userId: number
	org: BillingPageOrg
	seats: number
	canManage: boolean
	errorCode?: string | null
	noticeCode?: string | null
	now?: Date
}): Promise<AccountBillingLoaderData> {
	const now = input.now ?? new Date()
	const configured = isBillingConfigured(input.env)
	const error = resolveBillingErrorMessage(input.errorCode)
	const notice = resolveBillingNoticeMessage(input.noticeCode)
	const { org } = input

	const personal = org.personal
		? await readPersonalPlanState(input.env, input.userId)
		: null
	const state = personal ?? (await readTeamPlanState(input.env, org.id))
	let refreshed: RefreshedPlan = {
		stripePlan: state.stripePlan,
		creditsEligible: state.creditsEligible,
		stripeInterval: null,
		cancelAt: null,
		subscriptionStatus: null,
	}
	const { customerId } = state

	if (configured && customerId) {
		const backstopId = personal ? personal.stableUserId : org.id
		if (backstopId) {
			await scheduleStripePlanRefreshBackstop({
				env: input.env,
				userId: backstopId,
				now,
			})
		}
		// Always refresh on page view: cancel_at and subscriptionStatus are not
		// persisted, so serving the stored stripe_plan would hide a scheduled
		// cancellation or past_due state. Billing page loads are rare enough
		// that one Stripe call per view is fine; failures fall back to the
		// stored plan with null status.
		try {
			refreshed = personal
				? await refreshStripePlanForUser({
						env: input.env,
						userId: input.userId,
						customerId,
						now,
					})
				: await refreshStripePlanForOrg({
						env: input.env,
						orgId: org.id,
						customerId,
						now,
					})
		} catch (refreshError) {
			console.error('account_billing_refresh_failed', {
				userId: input.userId,
				orgId: org.id,
				error:
					refreshError instanceof Error
						? refreshError.message
						: String(refreshError),
			})
		}
	}

	const purchasablePlans = configured ? getPurchasablePlans(input.env) : []
	const origin = getCanonicalAppBaseUrl({ env: input.env })
	const referralProgram = state.referral
		? await loadReferralProgramSummary({
				db: input.env.APP_DB,
				stableUserId: state.referral.stableUserId,
				username: state.referral.username,
				origin,
				now,
			}).catch((referralError) => {
				console.error('account_billing_referral_failed', {
					userId: input.userId,
					error:
						referralError instanceof Error
							? referralError.message
							: String(referralError),
				})
				return null
			})
		: null

	return {
		ok: true,
		configured,
		manualPlan: state.manualPlan,
		stripePlan: refreshed.stripePlan,
		stripeInterval: refreshed.stripeInterval,
		effectivePlan: resolveEffectivePlanWithSecondAgentGift(
			state.manualPlan,
			refreshed.stripePlan,
			state.overlayExpiresAt,
			now,
		),
		hasStripeCustomer: Boolean(customerId),
		cancelAt: refreshed.cancelAt,
		subscriptionStatus: refreshed.subscriptionStatus,
		purchasablePlans,
		creditsEligible:
			refreshed.stripePlan === 'pro' && refreshed.creditsEligible,
		// Credits and usage are still metered per person.
		creditsHref: org.personal ? accountCreditsPath : null,
		usageHref: org.personal ? '/account/usage' : null,
		referralProgram,
		org: {
			slug: org.slug,
			displayName: org.displayName,
			personal: org.personal,
			seats: input.seats,
			canManage: input.canManage,
		},
		...(error ? { error } : {}),
		...(notice ? { notice } : {}),
	}
}
