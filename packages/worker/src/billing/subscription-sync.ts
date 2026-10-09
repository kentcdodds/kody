import { waitUntil } from 'cloudflare:workers'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import {
	sendBillingSuccessEmail,
	sendPastDueEmail,
} from '#app/user-account-emails.ts'
import { maybeSyncDiscordGuildRolesForUser } from '#worker/discord/guild-role.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	parseStripePlanName,
	resolveEntitlementLadderAfterPaidAccessChange,
	type PlanName,
} from '#universal/plans.ts'
import {
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { forgiveCreditUsageBeforeUnlock } from '#worker/billing/credit-wallet.ts'
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
import { scheduleStripePlanRefreshBackstop } from './stripe-plan-refresh-client.ts'
import {
	batchUsersAndPersonalOrgBillingUpdate,
	updateOrgBillingColumns,
} from '#worker/orgs/billing-dual-write.ts'
import { sendToOrgBillingRecipients } from './org-billing-emails.ts'
import { resolveOrgIdFromStripeMetadata } from './org-stripe-metadata.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

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
	const previous = await input.env.APP_DB.prepare(
		`SELECT email, stable_user_id, stripe_price_id,
		        ${userEntitlementColumnsSql()}
		 FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.userId)
		.first<
			UserEntitlementRow & {
				email: string
				stable_user_id: string
				stripe_price_id: string | null
			}
		>()
	const subscriptions = await listSubscriptions(input.env, input.customerId)
	const resolved = resolveSubscriptionPlan(subscriptions, input.env)
	const nextLadder = previous
		? resolveEntitlementLadderAfterPaidAccessChange({
				currentLadder: parseEntitlementLadder(previous.entitlement_ladder),
				manualPlan: parseStoredPlanName(previous.plan),
				previousStripePlan: parseStripePlanName(previous.stripe_plan),
				nextStripePlan: resolved.stripePlan,
				previousStripePriceId: previous.stripe_price_id,
				nextStripePriceId: resolved.stripePriceId,
			})
		: 'public'
	if (previous) {
		await forgiveCreditUsageBeforeUnlock({
			db: input.env.APP_DB,
			userId: previous.stable_user_id,
			current: previous,
			next: {
				...previous,
				stripe_plan: resolved.stripePlan,
				stripe_credits_eligible: resolved.creditsEligible ? 1 : 0,
				entitlement_ladder: nextLadder,
			},
			now,
		})
	}
	if (!previous?.stable_user_id) {
		throw new Error(
			`Cannot refresh Stripe plan: missing stable_user_id for user ${input.userId}.`,
		)
	}
	const stripePlanRefreshedAt = now.toISOString()
	const stripeCreditsEligible = resolved.creditsEligible ? 1 : 0
	await batchUsersAndPersonalOrgBillingUpdate({
		db: input.env.APP_DB,
		stableUserId: previous.stable_user_id,
		usersStatement: input.env.APP_DB.prepare(
			`UPDATE users
			 SET stripe_plan = ?, stripe_price_id = ?, stripe_credits_eligible = ?,
			     stripe_plan_refreshed_at = ?, entitlement_ladder = ?
			 WHERE id = ? AND stripe_customer_id = ?${andLiveDeletedAtSql()}`,
		).bind(
			resolved.stripePlan,
			resolved.stripePriceId,
			stripeCreditsEligible,
			stripePlanRefreshedAt,
			nextLadder,
			input.userId,
			input.customerId,
		),
		orgSetClause: `stripe_plan = ?, stripe_price_id = ?, stripe_credits_eligible = ?,
		     stripe_plan_refreshed_at = ?, entitlement_ladder = ?, updated_at = ?`,
		orgValues: [
			resolved.stripePlan,
			resolved.stripePriceId,
			stripeCreditsEligible,
			stripePlanRefreshedAt,
			nextLadder,
			stripePlanRefreshedAt,
		],
		// Allow null org customer ids only while the users row still holds
		// this customer (dual-write lag). A stale refresh whose users UPDATE
		// matches zero rows must not write plan columns onto a null org.
		orgWhereSuffix: ` AND (
			stripe_customer_id = ?
			OR (
				stripe_customer_id IS NULL
				AND EXISTS (
					SELECT 1 FROM users u
					WHERE u.stable_user_id = orgs.id
					  AND u.stripe_customer_id = ?
				)
			)
		)`,
		orgWhereValues: [input.customerId, input.customerId],
	})
	waitUntil(
		maybeSyncDiscordGuildRolesForUser({
			env: input.env,
			userId: input.userId,
			stripePlan: resolved.stripePlan,
		}),
	)
	const orgId = previous?.stable_user_id
	if (orgId) {
		const previousPlan = parseStripePlanName(previous.stripe_plan)
		const nextPlan = resolved.stripePlan
		if (
			(nextPlan === 'standard' || nextPlan === 'pro') &&
			nextPlan !== previousPlan
		) {
			waitUntil(
				sendToOrgBillingRecipients({
					db: input.env.APP_DB,
					orgId,
					sendOne: async (recipient) => {
						await sendBillingSuccessEmail({
							env: input.env,
							email: recipient.email,
							userId: recipient.userId,
							planLabel: nextPlan === 'pro' ? 'Pro' : 'Standard',
						})
					},
				}).catch((error) => {
					console.warn('billing-success-email-failed', error)
				}),
			)
		}
		const status = resolved.subscriptionStatus
		if (status === 'past_due' || status === 'unpaid') {
			const day = utcDayKey(now)
			waitUntil(
				sendToOrgBillingRecipients({
					db: input.env.APP_DB,
					orgId,
					sendOne: async (recipient) => {
						await sendPastDueEmail({
							env: input.env,
							email: recipient.email,
							userId: recipient.userId,
							day,
						})
					},
				}).catch((error) => {
					console.warn('billing-past-due-email-failed', error)
				}),
			)
		}
	}
	if (previous?.email) {
		scheduleKitSubscriberSync({
			env: input.env,
			email: previous.email,
			stableUserId: previous.stable_user_id,
		})
	}
	return resolved
}

async function loadBillingUserById(
	env: SyncEnv,
	userId: number,
): Promise<BillingUser | null> {
	const row = await env.APP_DB.prepare(
		`SELECT id, email, stable_user_id FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
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
	metadata?: Record<string, string> | null
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

	const stableUserIdHint =
		resolveOrgIdFromStripeMetadata(input.metadata) ??
		input.stableUserIdHint?.trim() ??
		null
	if (stableUserIdHint) {
		const row = await input.env.APP_DB.prepare(
			`SELECT id, email, stable_user_id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
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
		const userRow = await input.env.APP_DB.prepare(
			`SELECT id, email, stable_user_id FROM users WHERE stripe_customer_id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(customerId)
			.first<{ id: number; email: string; stable_user_id: string }>()
		await pushCandidate(
			userRow
				? {
						id: userRow.id,
						email: userRow.email,
						stableUserId: userRow.stable_user_id,
					}
				: null,
		)
		const orgRow = await input.env.APP_DB.prepare(
			`SELECT o.id AS org_id, u.id, u.email, u.stable_user_id
			 FROM orgs o
			 INNER JOIN users u ON u.stable_user_id = o.id
			 WHERE o.stripe_customer_id = ?
			   AND o.deleted_at IS NULL`,
		)
			.bind(customerId)
			.first<{
				org_id: string
				id: number
				email: string
				stable_user_id: string
			}>()
		await pushCandidate(
			orgRow
				? {
						id: orgRow.id,
						email: orgRow.email,
						stableUserId: orgRow.stable_user_id,
					}
				: null,
		)
	}

	const customerEmail = input.customerEmail?.trim()
	if (customerEmail) {
		const normalized = normalizeEmail(customerEmail)
		const row = await input.env.APP_DB.prepare(
			`SELECT id, email, stable_user_id FROM users WHERE lower(email) = ?${andLiveDeletedAtSql()}`,
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
	const userRow = await input.env.APP_DB.prepare(
		`SELECT id FROM users WHERE stripe_customer_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(customerId)
		.first<{ id: number }>()
	if (userRow?.id != null) return userRow.id
	const orgRow = await input.env.APP_DB.prepare(
		`SELECT u.id
		 FROM orgs o
		 INNER JOIN users u ON u.stable_user_id = o.id
		 WHERE o.stripe_customer_id = ?
		   AND o.deleted_at IS NULL`,
	)
		.bind(customerId)
		.first<{ id: number }>()
	return orgRow?.id ?? null
}

/** Resolve the org that owns a Stripe customer (team or personal). */
export async function findOrgIdByStripeCustomerId(input: {
	env: SyncEnv
	customerId: string
}): Promise<string | null> {
	const customerId = input.customerId.trim()
	if (!customerId) return null
	const orgRow = await input.env.APP_DB.prepare(
		`SELECT id FROM orgs WHERE stripe_customer_id = ? AND deleted_at IS NULL`,
	)
		.bind(customerId)
		.first<{ id: string }>()
	if (orgRow?.id) return orgRow.id
	const userRow = await input.env.APP_DB.prepare(
		`SELECT stable_user_id FROM users WHERE stripe_customer_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(customerId)
		.first<{ stable_user_id: string }>()
	return userRow?.stable_user_id?.trim() || null
}

/**
 * Resolve the org id that owns a Checkout Session by verifying
 * `client_reference_id` against `createBillingLinkReference(orgId)`. Prefer
 * Stripe metadata (`kody_org_id`); never reverse the HMAC. Customer email is
 * a personal-org-only fallback (never used to resolve a team org).
 */
export async function resolveOrgIdForCheckoutLink(input: {
	env: SyncEnv
	clientReferenceId: string | null | undefined
	stableUserIdHint?: string | null
	metadata?: Record<string, string> | null
	customerId?: string | null
	customerEmail?: string | null
}): Promise<string | null> {
	const clientReferenceId = input.clientReferenceId?.trim()
	if (!clientReferenceId) return null

	const candidates: Array<string> = []
	const seen = new Set<string>()
	function pushCandidate(orgId: string | null | undefined) {
		const trimmed = orgId?.trim()
		if (!trimmed || seen.has(trimmed)) return
		seen.add(trimmed)
		candidates.push(trimmed)
	}

	pushCandidate(
		resolveOrgIdFromStripeMetadata(input.metadata) ??
			input.stableUserIdHint?.trim() ??
			null,
	)

	const customerId = input.customerId?.trim()
	if (customerId) {
		pushCandidate(
			await findOrgIdByStripeCustomerId({ env: input.env, customerId }),
		)
	}

	const customerEmail = input.customerEmail?.trim()
	if (customerEmail) {
		const row = await input.env.APP_DB.prepare(
			`SELECT stable_user_id FROM users WHERE lower(email) = ?${andLiveDeletedAtSql()}`,
		)
			.bind(normalizeEmail(customerEmail))
			.first<{ stable_user_id: string }>()
		// Personal org id equals the owner's stable user id. Never treat email
		// as a team-org resolver.
		pushCandidate(row?.stable_user_id)
	}

	for (const orgId of candidates) {
		const expected = await createBillingLinkReference(input.env, orgId)
		if (expected !== clientReferenceId) continue
		const org = await input.env.APP_DB.prepare(
			`SELECT id FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(orgId)
			.first<{ id: string }>()
		if (org?.id) return org.id
		// Personal org before/without an orgs row: stable user id is the org id.
		const user = await input.env.APP_DB.prepare(
			`SELECT stable_user_id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
			.bind(orgId)
			.first<{ stable_user_id: string }>()
		if (user?.stable_user_id) return user.stable_user_id
	}
	return null
}

async function loadCheckoutSessionForLink(input: {
	env: SyncEnv
	sessionId: string
}) {
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
	try {
		return await getCheckoutSession(input.env, sessionId)
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
}

async function refreshAfterCheckoutLink(input: {
	env: SyncEnv
	orgId: string
	customerId: string
	now: Date
}): Promise<ResolvedSubscriptionPlan> {
	const backstopScheduled = await scheduleStripePlanRefreshBackstop({
		env: input.env,
		userId: input.orgId,
		now: input.now,
	})
	try {
		return await refreshStripePlanForOrg({
			env: input.env,
			orgId: input.orgId,
			customerId: input.customerId,
			now: input.now,
		})
	} catch (error) {
		if (
			error instanceof StripeApiError ||
			error instanceof BillingNotConfiguredError
		) {
			if (!backstopScheduled) throw error
			console.error('billing_link_refresh_failed', {
				orgId: input.orgId,
				error: error instanceof Error ? error.message : String(error),
			})
			return {
				stripePlan: null,
				creditsEligible: false,
				stripeInterval: null,
				stripePriceId: null,
				cancelAt: null,
				subscriptionStatus: null,
			}
		}
		throw error
	}
}

/**
 * Link a completed Checkout Session's Stripe customer onto the org row
 * identified by `orgId`. `client_reference_id` must be the org-backed HMAC.
 * Personal orgs (org id = owner stable user id) still dual-write the users
 * row; team orgs write the team org row only — the authorizing member is
 * never the link target.
 */
export async function linkStripeCustomerFromCheckoutSessionForOrg(input: {
	env: SyncEnv
	orgId: string
	sessionId: string
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	const orgId = input.orgId.trim()
	if (!orgId) {
		throw new BillingLinkError(
			'user_not_found',
			'No Kody organization matched this checkout session attribution.',
		)
	}

	const session = await loadCheckoutSessionForLink({
		env: input.env,
		sessionId: input.sessionId,
	})

	const expectedReference = await createBillingLinkReference(input.env, orgId)
	if (session.client_reference_id !== expectedReference) {
		throw new BillingLinkError(
			'client_reference_mismatch',
			'This checkout session does not belong to this organization.',
		)
	}

	const customerId = session.customer?.trim()
	if (!customerId) {
		throw new BillingLinkError(
			'missing_customer',
			'The checkout session did not include a Stripe customer.',
		)
	}

	const personalUser = await input.env.APP_DB.prepare(
		`SELECT id, stripe_customer_id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(orgId)
		.first<{ id: number; stripe_customer_id: string | null }>()

	const orgRow = await input.env.APP_DB.prepare(
		`SELECT id, stripe_customer_id FROM orgs WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind(orgId)
		.first<{ id: string; stripe_customer_id: string | null }>()

	if (!orgRow && !personalUser) {
		throw new BillingLinkError(
			'user_not_found',
			'No Kody organization matched this checkout session attribution.',
		)
	}

	const claimedByOtherOrg = await input.env.APP_DB.prepare(
		`SELECT id FROM orgs
		 WHERE stripe_customer_id = ?
		   AND id != ?
		   AND deleted_at IS NULL`,
	)
		.bind(customerId, orgId)
		.first<{ id: string }>()
	if (claimedByOtherOrg) {
		throw new BillingLinkError(
			'customer_already_linked',
			'This Stripe customer is already linked to another Kody organization.',
		)
	}

	const claimedByOtherUser = await input.env.APP_DB.prepare(
		`SELECT id FROM users
		 WHERE stripe_customer_id = ?
		   AND stable_user_id != ?${andLiveDeletedAtSql()}`,
	)
		.bind(customerId, orgId)
		.first<{ id: number }>()
	if (claimedByOtherUser) {
		throw new BillingLinkError(
			'customer_already_linked',
			'This Stripe customer is already linked to another Kody account.',
		)
	}

	const existingOrgCustomer = orgRow?.stripe_customer_id?.trim() || null
	const existingUserCustomer = personalUser?.stripe_customer_id?.trim() || null
	const existingCustomerId = existingOrgCustomer ?? existingUserCustomer
	if (existingCustomerId && existingCustomerId !== customerId) {
		throw new BillingLinkError(
			'account_already_linked',
			'This organization is already linked to a different Stripe customer. Contact the operator to relink it.',
		)
	}

	const now = input.now ?? new Date()
	const updatedAt = now.toISOString()
	try {
		if (personalUser) {
			// Personal org: one dual-write to users + personal org row.
			await batchUsersAndPersonalOrgBillingUpdate({
				db: input.env.APP_DB,
				stableUserId: orgId,
				usersStatement: input.env.APP_DB.prepare(
					`UPDATE users
					 SET stripe_customer_id = ?, updated_at = ?
					 WHERE id = ?${andLiveDeletedAtSql()}`,
				).bind(customerId, updatedAt, personalUser.id),
				orgSetClause: 'stripe_customer_id = ?, updated_at = ?',
				orgValues: [customerId, updatedAt],
			})
		} else if (orgRow) {
			// Team org: org row only. Do not touch any member users row.
			await updateOrgBillingColumns({
				db: input.env.APP_DB,
				orgId,
				setClause: 'stripe_customer_id = ?, updated_at = ?',
				values: [customerId, updatedAt],
			})
		}
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

	return await refreshAfterCheckoutLink({
		env: input.env,
		orgId,
		customerId,
		now,
	})
}

/**
 * Personal-org convenience wrapper: org id equals the owner's stable user id.
 */
export async function linkStripeCustomerFromCheckoutSession(input: {
	env: SyncEnv
	user: BillingUser
	sessionId: string
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	return linkStripeCustomerFromCheckoutSessionForOrg({
		env: input.env,
		orgId: input.user.stableUserId,
		sessionId: input.sessionId,
		now: input.now,
	})
}

/**
 * Shared checkout-link path used by the success redirect and the
 * `checkout.session.completed` webhook. The link target is always an org;
 * the signed-in member is only the authorizing actor on the success path.
 */
export async function linkStripeCustomerFromCheckoutSessionAttribution(input: {
	env: SyncEnv
	sessionId: string
	clientReferenceId?: string | null
	stableUserIdHint?: string | null
	metadata?: Record<string, string> | null
	customerId?: string | null
	customerEmail?: string | null
	/** Prefer this: request-bound org id from the success redirect. */
	orgId?: string
	/**
	 * Legacy personal success path: treated as org id = stable user id.
	 * Prefer `orgId`.
	 */
	user?: BillingUser
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	if (input.orgId?.trim()) {
		return linkStripeCustomerFromCheckoutSessionForOrg({
			env: input.env,
			orgId: input.orgId.trim(),
			sessionId: input.sessionId,
			now: input.now,
		})
	}
	if (input.user) {
		return linkStripeCustomerFromCheckoutSessionForOrg({
			env: input.env,
			orgId: input.user.stableUserId,
			sessionId: input.sessionId,
			now: input.now,
		})
	}

	let clientReferenceId = input.clientReferenceId
	let metadata = input.metadata
	let customerId = input.customerId
	if (clientReferenceId == null || metadata == null || customerId == null) {
		const session = await loadCheckoutSessionForLink({
			env: input.env,
			sessionId: input.sessionId,
		})
		clientReferenceId = clientReferenceId ?? session.client_reference_id
		metadata = metadata ?? session.metadata ?? null
		customerId = customerId ?? session.customer
	}

	const orgId = await resolveOrgIdForCheckoutLink({
		env: input.env,
		clientReferenceId,
		stableUserIdHint: input.stableUserIdHint,
		metadata,
		customerId,
		customerEmail: input.customerEmail,
	})
	if (!orgId) {
		throw new BillingLinkError(
			'user_not_found',
			'No Kody organization matched this checkout session attribution.',
		)
	}
	return linkStripeCustomerFromCheckoutSessionForOrg({
		env: input.env,
		orgId,
		sessionId: input.sessionId,
		now: input.now,
	})
}

/**
 * Refresh stripe_plan columns for an org. Personal orgs dual-write through
 * {@link refreshStripePlanForUser}; team orgs update the orgs row only.
 */
export async function refreshStripePlanForOrg(input: {
	env: SyncEnv
	orgId: string
	customerId: string
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	const orgId = input.orgId.trim()
	const personalUser = await input.env.APP_DB.prepare(
		`SELECT id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(orgId)
		.first<{ id: number }>()
	if (personalUser?.id != null) {
		return refreshStripePlanForUser({
			env: input.env,
			userId: personalUser.id,
			customerId: input.customerId,
			now: input.now,
		})
	}

	const now = input.now ?? new Date()
	const previous = await input.env.APP_DB.prepare(
		`SELECT stripe_price_id, ${userEntitlementColumnsSql()}
		 FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(orgId)
		.first<UserEntitlementRow & { stripe_price_id: string | null }>()
	if (!previous) {
		throw new Error(`Cannot refresh Stripe plan: missing org ${orgId}.`)
	}
	const subscriptions = await listSubscriptions(input.env, input.customerId)
	const resolved = resolveSubscriptionPlan(subscriptions, input.env)
	const nextLadder = resolveEntitlementLadderAfterPaidAccessChange({
		currentLadder: parseEntitlementLadder(previous.entitlement_ladder),
		manualPlan: parseStoredPlanName(previous.plan),
		previousStripePlan: parseStripePlanName(previous.stripe_plan),
		nextStripePlan: resolved.stripePlan,
		previousStripePriceId: previous.stripe_price_id,
		nextStripePriceId: resolved.stripePriceId,
	})
	await forgiveCreditUsageBeforeUnlock({
		db: input.env.APP_DB,
		userId: orgId,
		current: previous,
		next: {
			...previous,
			stripe_plan: resolved.stripePlan,
			stripe_credits_eligible: resolved.creditsEligible ? 1 : 0,
			entitlement_ladder: nextLadder,
		},
		now,
	})
	const stripePlanRefreshedAt = now.toISOString()
	const stripeCreditsEligible = resolved.creditsEligible ? 1 : 0
	await updateOrgBillingColumns({
		db: input.env.APP_DB,
		orgId,
		setClause: `stripe_plan = ?, stripe_price_id = ?, stripe_credits_eligible = ?,
		     stripe_plan_refreshed_at = ?, entitlement_ladder = ?, updated_at = ?`,
		values: [
			resolved.stripePlan,
			resolved.stripePriceId,
			stripeCreditsEligible,
			stripePlanRefreshedAt,
			nextLadder,
			stripePlanRefreshedAt,
		],
		orgWhereSuffix: ' AND stripe_customer_id = ?',
		orgWhereValues: [input.customerId],
	})

	const previousPlan = parseStripePlanName(previous.stripe_plan)
	const nextPlan = resolved.stripePlan
	if (
		(nextPlan === 'standard' || nextPlan === 'pro') &&
		nextPlan !== previousPlan
	) {
		waitUntil(
			sendToOrgBillingRecipients({
				db: input.env.APP_DB,
				orgId,
				sendOne: async (recipient) => {
					await sendBillingSuccessEmail({
						env: input.env,
						email: recipient.email,
						userId: recipient.userId,
						planLabel: nextPlan === 'pro' ? 'Pro' : 'Standard',
					})
				},
			}).catch((error) => {
				console.warn('billing-success-email-failed', error)
			}),
		)
	}
	const status = resolved.subscriptionStatus
	if (status === 'past_due' || status === 'unpaid') {
		const day = utcDayKey(now)
		waitUntil(
			sendToOrgBillingRecipients({
				db: input.env.APP_DB,
				orgId,
				sendOne: async (recipient) => {
					await sendPastDueEmail({
						env: input.env,
						email: recipient.email,
						userId: recipient.userId,
						day,
					})
				},
			}).catch((error) => {
				console.warn('billing-past-due-email-failed', error)
			}),
		)
	}
	return resolved
}

export async function refreshStripePlanForStripeCustomer(input: {
	env: SyncEnv
	customerId: string
	now?: Date
}): Promise<{
	userId: number | null
	orgId: string | null
	resolved: ResolvedSubscriptionPlan | null
}> {
	const userId = await findUserIdByStripeCustomerId({
		env: input.env,
		customerId: input.customerId,
	})
	if (userId != null) {
		const user = await loadBillingUserById(input.env, userId)
		if (!user) {
			return { userId: null, orgId: null, resolved: null }
		}
		await scheduleStripePlanRefreshBackstop({
			env: input.env,
			userId: user.stableUserId,
			now: input.now,
		})
		const resolved = await refreshStripePlanForUser({
			env: input.env,
			userId: user.id,
			customerId: input.customerId,
			now: input.now,
		})
		return { userId: user.id, orgId: user.stableUserId, resolved }
	}

	const orgId = await findOrgIdByStripeCustomerId({
		env: input.env,
		customerId: input.customerId,
	})
	if (!orgId) {
		return { userId: null, orgId: null, resolved: null }
	}
	await scheduleStripePlanRefreshBackstop({
		env: input.env,
		userId: orgId,
		now: input.now,
	})
	const resolved = await refreshStripePlanForOrg({
		env: input.env,
		orgId,
		customerId: input.customerId,
		now: input.now,
	})
	return { userId: null, orgId, resolved }
}

export function parseStoredStripePlan(value: string | null | undefined) {
	return parseStripePlanName(value)
}

export type { PlanName, ResolvedSubscriptionPlan }
