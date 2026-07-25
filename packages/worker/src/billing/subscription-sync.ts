import { normalizeEmail } from '#app/normalize-email.ts'
import {
	parseStripePlanName,
	type PlanName,
} from '#worker/entitlements/plans.ts'
import {
	createBillingLinkReference,
	isBillingConfigured,
	resolveSubscriptionPlan,
	type ResolvedSubscriptionPlan,
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
		| 'user_not_found'

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
}): Promise<ResolvedSubscriptionPlan> {
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

async function loadBillingUserById(
	env: SyncEnv,
	userId: number,
): Promise<BillingUser | null> {
	const row = await env.APP_DB.prepare(
		`SELECT id, email, stable_user_id FROM users WHERE id = ?`,
	)
		.bind(userId)
		.first<{ id: number; email: string; stable_user_id: string }>()
	if (!row) return null
	return {
		id: row.id,
		email: row.email,
		stableUserId: row.stable_user_id,
	}
}

/**
 * Resolve the Kody user that owns a Checkout Session by verifying
 * `client_reference_id` against `createBillingLinkReference`. Candidate users
 * are found via stable-user-id hint (session metadata), Stripe customer id, or
 * customer email — never by reversing the HMAC.
 */
export async function resolveBillingUserForCheckoutLink(input: {
	env: SyncEnv
	clientReferenceId: string | null | undefined
	stableUserIdHint?: string | null
	customerId?: string | null
	customerEmail?: string | null
}): Promise<BillingUser | null> {
	const clientReferenceId = input.clientReferenceId?.trim()
	if (!clientReferenceId) return null

	const candidates: Array<BillingUser> = []
	const seenIds = new Set<number>()

	async function pushCandidate(user: BillingUser | null) {
		if (!user || seenIds.has(user.id)) return
		seenIds.add(user.id)
		candidates.push(user)
	}

	const stableUserIdHint = input.stableUserIdHint?.trim()
	if (stableUserIdHint) {
		const row = await input.env.APP_DB.prepare(
			`SELECT id, email, stable_user_id FROM users WHERE stable_user_id = ?`,
		)
			.bind(stableUserIdHint)
			.first<{ id: number; email: string; stable_user_id: string }>()
		await pushCandidate(
			row
				? {
						id: row.id,
						email: row.email,
						stableUserId: row.stable_user_id,
					}
				: null,
		)
	}

	const customerId = input.customerId?.trim()
	if (customerId) {
		const row = await input.env.APP_DB.prepare(
			`SELECT id, email, stable_user_id FROM users WHERE stripe_customer_id = ?`,
		)
			.bind(customerId)
			.first<{ id: number; email: string; stable_user_id: string }>()
		await pushCandidate(
			row
				? {
						id: row.id,
						email: row.email,
						stableUserId: row.stable_user_id,
					}
				: null,
		)
	}

	const customerEmail = input.customerEmail?.trim()
	if (customerEmail) {
		const normalized = normalizeEmail(customerEmail)
		const row = await input.env.APP_DB.prepare(
			`SELECT id, email, stable_user_id FROM users WHERE lower(email) = ?`,
		)
			.bind(normalized)
			.first<{ id: number; email: string; stable_user_id: string }>()
		await pushCandidate(
			row
				? {
						id: row.id,
						email: row.email,
						stableUserId: row.stable_user_id,
					}
				: null,
		)
	}

	for (const candidate of candidates) {
		const expected = await createBillingLinkReference(
			input.env,
			candidate.stableUserId,
		)
		if (expected === clientReferenceId) {
			return candidate
		}
	}
	return null
}

export async function findUserIdByStripeCustomerId(input: {
	env: SyncEnv
	customerId: string
}): Promise<number | null> {
	const customerId = input.customerId.trim()
	if (!customerId) return null
	const row = await input.env.APP_DB.prepare(
		`SELECT id FROM users WHERE stripe_customer_id = ?`,
	)
		.bind(customerId)
		.first<{ id: number }>()
	return row?.id ?? null
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
}): Promise<ResolvedSubscriptionPlan> {
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
			return { stripePlan: null, cancelAt: null, subscriptionStatus: null }
		}
		throw error
	}
}

/**
 * Shared checkout-link path used by the success redirect and the
 * `checkout.session.completed` webhook: resolve the owning user from session
 * attribution fields, then run the same link+refresh logic.
 */
export async function linkStripeCustomerFromCheckoutSessionAttribution(input: {
	env: SyncEnv
	sessionId: string
	clientReferenceId?: string | null
	stableUserIdHint?: string | null
	customerId?: string | null
	customerEmail?: string | null
	/** When set (success redirect), skip candidate lookup and use this user. */
	user?: BillingUser
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	if (input.user) {
		return linkStripeCustomerFromCheckoutSession({
			env: input.env,
			user: input.user,
			sessionId: input.sessionId,
			now: input.now,
		})
	}

	const user = await resolveBillingUserForCheckoutLink({
		env: input.env,
		clientReferenceId: input.clientReferenceId,
		stableUserIdHint: input.stableUserIdHint,
		customerId: input.customerId,
		customerEmail: input.customerEmail,
	})
	if (!user) {
		throw new BillingLinkError(
			'user_not_found',
			'No Kody account matched this checkout session attribution.',
		)
	}
	return linkStripeCustomerFromCheckoutSession({
		env: input.env,
		user,
		sessionId: input.sessionId,
		now: input.now,
	})
}

export async function refreshStripePlanForStripeCustomer(input: {
	env: SyncEnv
	customerId: string
	now?: Date
}): Promise<{
	userId: number | null
	resolved: ResolvedSubscriptionPlan | null
}> {
	const userId = await findUserIdByStripeCustomerId({
		env: input.env,
		customerId: input.customerId,
	})
	if (userId == null) {
		return { userId: null, resolved: null }
	}
	const user = await loadBillingUserById(input.env, userId)
	if (!user) {
		return { userId: null, resolved: null }
	}
	const resolved = await refreshStripePlanForUser({
		env: input.env,
		userId: user.id,
		customerId: input.customerId,
		now: input.now,
	})
	return { userId: user.id, resolved }
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
	return parseStripePlanName(value)
}

export type { PlanName, ResolvedSubscriptionPlan }
