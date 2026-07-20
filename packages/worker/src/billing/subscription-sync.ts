import { parsePlanName, type PlanName } from '#worker/entitlements/plans.ts'
import {
	createBillingLinkReference,
	isBillingConfigured,
	resolveSubscriptionPlan,
} from './billing-config.ts'
import {
	BillingNotConfiguredError,
	getCheckoutSession,
	listSubscriptions,
	StripeApiError,
} from './stripe-client.ts'

const staleRefreshMs = 60 * 60 * 1000
const cronRefreshLimit = 25

export class BillingLinkError extends Error {
	readonly code:
		| 'billing_not_configured'
		| 'missing_session'
		| 'client_reference_mismatch'
		| 'missing_customer'
		| 'customer_already_linked'
		| 'account_already_linked'
		| 'stripe_error'

	constructor(
		code: BillingLinkError['code'],
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options)
		this.name = 'BillingLinkError'
		this.code = code
	}
}

type BillingUser = {
	id: number
	email: string
	stableUserId: string
}

type SyncEnv = Env

export async function refreshStripePlanForUser(input: {
	env: SyncEnv
	userId: number
	customerId: string
	now?: Date
}): Promise<{ stripePlan: PlanName | null; cancelAt: string | null }> {
	const now = input.now ?? new Date()
	const subscriptions = await listSubscriptions(input.env, input.customerId)
	const resolved = resolveSubscriptionPlan(subscriptions, input.env)
	await input.env.APP_DB.prepare(
		`UPDATE users
		 SET stripe_plan = ?, stripe_plan_refreshed_at = ?
		 WHERE id = ? AND stripe_customer_id = ?`,
	)
		.bind(
			resolved.stripePlan,
			now.toISOString(),
			input.userId,
			input.customerId,
		)
		.run()
	return resolved
}

/**
 * Verify a completed Stripe Checkout session belongs to the logged-in user
 * (`client_reference_id` must equal their stable user id), link the Stripe
 * customer id uniquely onto their users row, then refresh stripe_plan.
 */
export async function linkStripeCustomerFromCheckoutSession(input: {
	env: SyncEnv
	user: BillingUser
	sessionId: string
	now?: Date
}): Promise<{ stripePlan: PlanName | null; cancelAt: string | null }> {
	if (!isBillingConfigured(input.env)) {
		throw new BillingLinkError(
			'billing_not_configured',
			'Stripe billing is not configured on this deployment.',
		)
	}
	const sessionId = input.sessionId.trim()
	if (!sessionId) {
		throw new BillingLinkError(
			'missing_session',
			'Checkout session id is missing.',
		)
	}

	let session
	try {
		session = await getCheckoutSession(input.env, sessionId)
	} catch (error) {
		if (error instanceof BillingNotConfiguredError) {
			throw new BillingLinkError(
				'billing_not_configured',
				'Stripe billing is not configured on this deployment.',
				{ cause: error },
			)
		}
		throw new BillingLinkError(
			'stripe_error',
			'Unable to verify the Stripe checkout session.',
			{ cause: error },
		)
	}

	// The reference is an HMAC of the stable user id keyed by the deployment
	// cookie secret, so it cannot be derived from a (guessable) email hash by
	// an attacker who obtains or forges a Checkout Session client_reference_id.
	const expectedReference = await createBillingLinkReference(
		input.env,
		input.user.stableUserId,
	)
	if (session.client_reference_id !== expectedReference) {
		throw new BillingLinkError(
			'client_reference_mismatch',
			'This checkout session does not belong to your account.',
		)
	}

	const customerId = session.customer?.trim()
	if (!customerId) {
		throw new BillingLinkError(
			'missing_customer',
			'The checkout session did not include a Stripe customer.',
		)
	}

	const claimedBy = await input.env.APP_DB.prepare(
		`SELECT id FROM users WHERE stripe_customer_id = ? AND id != ?`,
	)
		.bind(customerId, input.user.id)
		.first<{ id: number }>()
	if (claimedBy) {
		throw new BillingLinkError(
			'customer_already_linked',
			'This Stripe customer is already linked to another Kody account.',
		)
	}

	// First-link or same-customer only: this endpoint is a GET (Stripe's
	// redirect target), so never let a later checkout session silently
	// replace an established linkage.
	const existing = await input.env.APP_DB.prepare(
		`SELECT stripe_customer_id FROM users WHERE id = ?`,
	)
		.bind(input.user.id)
		.first<{ stripe_customer_id: string | null }>()
	const existingCustomerId = existing?.stripe_customer_id?.trim() || null
	if (existingCustomerId && existingCustomerId !== customerId) {
		throw new BillingLinkError(
			'account_already_linked',
			'Your account is already linked to a different Stripe customer. Contact the operator to relink it.',
		)
	}

	const now = input.now ?? new Date()
	try {
		await input.env.APP_DB.prepare(
			`UPDATE users
			 SET stripe_customer_id = ?, updated_at = ?
			 WHERE id = ?`,
		)
			.bind(customerId, now.toISOString(), input.user.id)
			.run()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE constraint failed/i.test(message)) {
			throw new BillingLinkError(
				'customer_already_linked',
				'This Stripe customer is already linked to another Kody account.',
				{ cause: error },
			)
		}
		throw error
	}

	try {
		return await refreshStripePlanForUser({
			env: input.env,
			userId: input.user.id,
			customerId,
			now,
		})
	} catch (error) {
		if (
			error instanceof StripeApiError ||
			error instanceof BillingNotConfiguredError
		) {
			// The customer is linked; a failed plan refresh must not surface as
			// a checkout error. The billing page refreshes on view and the
			// hourly cron sweep retries, so the plan converges shortly.
			console.error('billing_link_refresh_failed', {
				userId: input.user.id,
				error: error instanceof Error ? error.message : String(error),
			})
			return { stripePlan: null, cancelAt: null }
		}
		throw error
	}
}

/**
 * Cron sweep: refresh stripe_plan for up to 25 users whose
 * stripe_plan_refreshed_at is older than 1 hour (or null). Skipped entirely
 * when billing is not configured. Per-user failures are logged and do not
 * halt the sweep.
 */
export async function refreshStaleStripePlans(input: {
	env: SyncEnv
	now?: Date
}): Promise<{ refreshed: number; failed: number; skipped: boolean }> {
	if (!isBillingConfigured(input.env)) {
		return { refreshed: 0, failed: 0, skipped: true }
	}
	const now = input.now ?? new Date()
	const staleBefore = new Date(now.valueOf() - staleRefreshMs).toISOString()
	const rows = await input.env.APP_DB.prepare(
		`SELECT id, stripe_customer_id
		 FROM users
		 WHERE stripe_customer_id IS NOT NULL
		   AND (stripe_plan_refreshed_at IS NULL OR stripe_plan_refreshed_at < ?)
		 ORDER BY stripe_plan_refreshed_at ASC
		 LIMIT ?`,
	)
		.bind(staleBefore, cronRefreshLimit)
		.all<{ id: number; stripe_customer_id: string }>()

	let refreshed = 0
	let failed = 0
	for (const row of rows.results ?? []) {
		try {
			await refreshStripePlanForUser({
				env: input.env,
				userId: row.id,
				customerId: row.stripe_customer_id,
				now,
			})
			refreshed += 1
		} catch (error) {
			failed += 1
			console.error('stripe_plan_refresh_failed', {
				userId: row.id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return { refreshed, failed, skipped: false }
}

export function parseStoredStripePlan(value: string | null | undefined) {
	return parsePlanName(value)
}
