/**
 * Referral attribution at signup and invoice-gated Standard credit.
 * Reward is one stacked month for both parties; there is no annual or
 * lifetime cap on how many a referrer can earn.
 */

import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { computeOverageInvoiceMetadataKey } from '#worker/billing/stripe-client.ts'
import {
	isReferralStandardCreditActive,
	laterIsoTimestamp,
	normalizeEmailForReferralFraud,
	normalizeReferralCode,
	referralSharePath,
	referralStandardCreditDurationMs,
	unixSecondsToIso,
	type ReferralProgramListItem,
	type ReferralProgramSummary,
	type ReferralRejectReason,
} from '#universal/referral-program.ts'

export type ReferralAttributionOutcome =
	| { outcome: 'attributed' }
	| { outcome: 'ignored'; reason: 'missing_code' | 'unknown_referrer' | 'self' }
	| { outcome: 'already_attributed' }

export type ReferralRewardOutcome =
	| { outcome: 'rewarded' }
	| { outcome: 'held_unverified' }
	| { outcome: 'already_rewarded' }
	| { outcome: 'rejected'; reason: ReferralRejectReason }
	| { outcome: 'ignored'; reason: 'no_pending' | 'invoice_unqualified' }

type ReferralParty = {
	stable_user_id: string
	username: string
	email: string
	email_verified_at: string | null
	stripe_customer_id: string | null
	account_type: string | null
	referral_standard_credit_expires_at: string | null
}

type PendingReferralRow = {
	id: number
	referrer_stable_user_id: string
	referee_stable_user_id: string
	status: string
	reward_invoice_id: string | null
	held_invoice_id: string | null
	held_period_end_at: string | null
	credits_granted_at: string | null
}

export function isQualifyingPaidReferralInvoice(invoice: {
	status?: unknown
	paid?: unknown
	amount_paid?: unknown
	billing_reason?: unknown
	subscription?: unknown
	metadata?: Record<string, string> | null
}): boolean {
	const amountPaid =
		typeof invoice.amount_paid === 'number' ? invoice.amount_paid : Number.NaN
	if (!Number.isFinite(amountPaid) || amountPaid <= 0) return false
	const status = typeof invoice.status === 'string' ? invoice.status.trim() : ''
	const paid = invoice.paid === true || status === 'paid'
	if (!paid) return false
	if (invoice.metadata?.[computeOverageInvoiceMetadataKey] === '1') {
		return false
	}
	const reason =
		typeof invoice.billing_reason === 'string'
			? invoice.billing_reason.trim()
			: ''
	const hasSubscription =
		typeof invoice.subscription === 'string' &&
		invoice.subscription.trim().length > 0
	if (reason === 'manual' && !hasSubscription) return false
	if (reason === 'upcoming') return false
	return true
}

export function readStripeInvoiceCustomerId(
	object: Record<string, unknown>,
): string | null {
	const customer = object.customer
	if (typeof customer === 'string' && customer.trim()) return customer.trim()
	if (customer && typeof customer === 'object' && 'id' in customer) {
		const id = (customer as { id?: unknown }).id
		if (typeof id === 'string' && id.trim()) return id.trim()
	}
	return null
}

export function readStripeInvoiceId(
	object: Record<string, unknown>,
): string | null {
	const id = object.id
	return typeof id === 'string' && id.trim() ? id.trim() : null
}

export function readStripeInvoicePeriodEndIso(
	object: Record<string, unknown>,
): string | null {
	const lines = object.lines
	const ends: Array<string> = []
	if (lines && typeof lines === 'object' && 'data' in lines) {
		const data = (lines as { data?: unknown }).data
		if (Array.isArray(data)) {
			for (const line of data) {
				if (!line || typeof line !== 'object') continue
				const period = (line as { period?: { end?: unknown } }).period
				const iso = unixSecondsToIso(period?.end)
				if (iso) ends.push(iso)
			}
		}
	}
	return laterIsoTimestamp(...ends)
}

export function readStripeInvoiceSubscriptionId(
	object: Record<string, unknown>,
): string | null {
	const top = object.subscription
	if (typeof top === 'string' && top.trim()) return top.trim()
	const parent = object.parent
	if (parent && typeof parent === 'object') {
		const details = (
			parent as { subscription_details?: { subscription?: unknown } }
		).subscription_details
		const nested = details?.subscription
		if (typeof nested === 'string' && nested.trim()) return nested.trim()
	}
	return null
}

export async function attributeReferralAtSignup(input: {
	db: D1Database
	refereeStableUserId: string
	refereeUsername: string
	referralCode: string | null | undefined
	now?: Date
}): Promise<ReferralAttributionOutcome> {
	if (typeof input.db.prepare !== 'function') {
		return { outcome: 'ignored', reason: 'missing_code' }
	}
	const code = normalizeReferralCode(input.referralCode)
	if (!code) return { outcome: 'ignored', reason: 'missing_code' }
	if (code === normalizeReferralCode(input.refereeUsername)) {
		return { outcome: 'ignored', reason: 'self' }
	}
	const referrer = await input.db
		.prepare(
			`SELECT stable_user_id, account_type
			 FROM users
			 WHERE username = ?`,
		)
		.bind(code)
		.first<{ stable_user_id: string; account_type: string | null }>()
	if (!referrer?.stable_user_id) {
		return { outcome: 'ignored', reason: 'unknown_referrer' }
	}
	if (referrer.stable_user_id === input.refereeStableUserId) {
		return { outcome: 'ignored', reason: 'self' }
	}
	if (referrer.account_type === 'platform') {
		return { outcome: 'ignored', reason: 'unknown_referrer' }
	}
	const now = input.now ?? new Date()
	try {
		await input.db
			.prepare(
				`INSERT INTO referrals (
					referrer_stable_user_id, referee_stable_user_id, created_at, status
				) VALUES (?, ?, ?, 'pending')`,
			)
			.bind(
				referrer.stable_user_id,
				input.refereeStableUserId,
				now.toISOString(),
			)
			.run()
		return { outcome: 'attributed' }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE constraint failed/i.test(message)) {
			return { outcome: 'already_attributed' }
		}
		throw error
	}
}

async function loadParty(
	db: D1Database,
	stableUserId: string,
): Promise<ReferralParty | null> {
	return db
		.prepare(
			`SELECT stable_user_id, username, email, email_verified_at,
			        stripe_customer_id, account_type,
			        referral_standard_credit_expires_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(stableUserId)
		.first<ReferralParty>()
}

function rejectReasonForParties(
	referrer: ReferralParty,
	referee: ReferralParty,
): ReferralRejectReason | null {
	if (referrer.stable_user_id === referee.stable_user_id) {
		return 'self_referral'
	}
	if (referrer.account_type === 'platform') {
		return 'platform_referrer'
	}
	if (
		normalizeEmailForReferralFraud(referrer.email) ===
		normalizeEmailForReferralFraud(referee.email)
	) {
		return 'same_email'
	}
	const referrerCustomer = referrer.stripe_customer_id?.trim() || null
	const refereeCustomer = referee.stripe_customer_id?.trim() || null
	if (
		referrerCustomer &&
		refereeCustomer &&
		referrerCustomer === refereeCustomer
	) {
		return 'same_stripe_customer'
	}
	return null
}

async function markRejected(
	db: D1Database,
	referralId: number,
	reason: ReferralRejectReason,
) {
	await db
		.prepare(
			`UPDATE referrals
			 SET status = 'rejected', reject_reason = ?, rewarded_at = NULL
			 WHERE id = ? AND status = 'pending'`,
		)
		.bind(reason, referralId)
		.run()
}

function stackReferralCreditStatement(input: {
	db: D1Database
	stableUserId: string
	paidPeriodEndAt: string | null
	referralId: number
	invoiceId: string
	now: Date
}) {
	return input.db
		.prepare(
			`UPDATE users
			 SET referral_standard_credit_expires_at = strftime(
			       '%Y-%m-%dT%H:%M:%fZ',
			       max(
			         strftime('%s', ?),
			         COALESCE(strftime('%s', referral_standard_credit_expires_at), 0),
			         COALESCE(strftime('%s', ?), 0)
			       ) + ?,
			       'unixepoch'
			     ),
			     updated_at = ?
			 WHERE stable_user_id = ?
			   AND EXISTS (
			     SELECT 1 FROM referrals
			     WHERE id = ?
			       AND reward_invoice_id = ?
			       AND credits_granted_at IS NULL
			   )`,
		)
		.bind(
			input.now.toISOString(),
			input.paidPeriodEndAt ?? '1970-01-01T00:00:00.000Z',
			referralStandardCreditDurationMs / 1000,
			utcSqliteTimestamp(input.now),
			input.stableUserId,
			input.referralId,
			input.invoiceId,
		)
}

export async function rewardReferralForPaidInvoice(input: {
	db: D1Database
	refereeStableUserId: string
	invoiceId: string
	invoiceQualifies: boolean
	paidPeriodEndAt?: string | null
	referrerPaidPeriodEndAt?: string | null
	now?: Date
}): Promise<ReferralRewardOutcome> {
	if (typeof input.db.prepare !== 'function') {
		return { outcome: 'ignored', reason: 'no_pending' }
	}
	const now = input.now ?? new Date()
	const pending = await input.db
		.prepare(
			`SELECT id, referrer_stable_user_id, referee_stable_user_id, status,
			        reward_invoice_id, held_invoice_id, held_period_end_at,
			        credits_granted_at
			 FROM referrals
			 WHERE referee_stable_user_id = ?`,
		)
		.bind(input.refereeStableUserId)
		.first<PendingReferralRow>()
	if (!pending) return { outcome: 'ignored', reason: 'no_pending' }
	if (pending.status === 'rewarded' && pending.credits_granted_at) {
		return { outcome: 'already_rewarded' }
	}
	if (pending.status !== 'pending' && pending.status !== 'rewarded') {
		return { outcome: 'ignored', reason: 'no_pending' }
	}
	if (!input.invoiceQualifies) {
		return { outcome: 'ignored', reason: 'invoice_unqualified' }
	}

	const [referrer, referee] = await Promise.all([
		loadParty(input.db, pending.referrer_stable_user_id),
		loadParty(input.db, pending.referee_stable_user_id),
	])
	if (!referrer || !referee) return { outcome: 'ignored', reason: 'no_pending' }

	const reject = rejectReasonForParties(referrer, referee)
	if (reject) {
		await markRejected(input.db, pending.id, reject)
		return { outcome: 'rejected', reason: reject }
	}

	if (!referrer.email_verified_at || !referee.email_verified_at) {
		await input.db
			.prepare(
				`UPDATE referrals
				 SET held_invoice_id = COALESCE(held_invoice_id, ?),
				     held_period_end_at = COALESCE(held_period_end_at, ?)
				 WHERE id = ? AND status = 'pending'`,
			)
			.bind(input.invoiceId, input.paidPeriodEndAt ?? null, pending.id)
			.run()
		return { outcome: 'held_unverified' }
	}

	const rewardedAt = now.toISOString()
	const invoiceId =
		pending.status === 'rewarded'
			? (pending.reward_invoice_id ?? input.invoiceId)
			: input.invoiceId
	await input.db.batch([
		input.db
			.prepare(
				`UPDATE referrals
				 SET status = 'rewarded',
				     rewarded_at = COALESCE(rewarded_at, ?),
				     reward_invoice_id = COALESCE(reward_invoice_id, ?),
				     held_invoice_id = NULL,
				     held_period_end_at = NULL
				 WHERE id = ? AND (status = 'pending' OR credits_granted_at IS NULL)`,
			)
			.bind(rewardedAt, invoiceId, pending.id),
		stackReferralCreditStatement({
			db: input.db,
			stableUserId: referrer.stable_user_id,
			paidPeriodEndAt: input.referrerPaidPeriodEndAt ?? null,
			referralId: pending.id,
			invoiceId,
			now,
		}),
		stackReferralCreditStatement({
			db: input.db,
			stableUserId: referee.stable_user_id,
			paidPeriodEndAt: input.paidPeriodEndAt ?? null,
			referralId: pending.id,
			invoiceId,
			now,
		}),
		input.db
			.prepare(
				`UPDATE referrals
				 SET credits_granted_at = ?
				 WHERE id = ? AND credits_granted_at IS NULL`,
			)
			.bind(rewardedAt, pending.id),
	])
	const granted = await input.db
		.prepare(
			`SELECT credits_granted_at, reward_invoice_id
			 FROM referrals WHERE id = ?`,
		)
		.bind(pending.id)
		.first<{
			credits_granted_at: string | null
			reward_invoice_id: string | null
		}>()
	if (
		granted?.credits_granted_at &&
		granted.reward_invoice_id !== input.invoiceId
	) {
		return { outcome: 'already_rewarded' }
	}
	if (!granted?.credits_granted_at) {
		return { outcome: 'already_rewarded' }
	}
	return { outcome: 'rewarded' }
}

export async function maybeRewardHeldReferralAfterEmailVerified(input: {
	db: D1Database
	stableUserId: string
	referrerPaidPeriodEndAt?: string | null
	resolveReferrerPaidPeriodEnd?: (
		referrerStableUserId: string,
	) => Promise<string | null>
	now?: Date
}): Promise<ReferralRewardOutcome | { outcome: 'ignored'; reason: 'no_held' }> {
	if (typeof input.db.prepare !== 'function') {
		return { outcome: 'ignored', reason: 'no_held' }
	}
	const held = await input.db
		.prepare(
			`SELECT id, referrer_stable_user_id, referee_stable_user_id, status,
			        reward_invoice_id, held_invoice_id, held_period_end_at,
			        credits_granted_at
			 FROM referrals
			 WHERE (referee_stable_user_id = ? OR referrer_stable_user_id = ?)
			   AND status = 'pending'
			   AND held_invoice_id IS NOT NULL
			 ORDER BY created_at ASC`,
		)
		.bind(input.stableUserId, input.stableUserId)
		.all<PendingReferralRow>()
	const rows = held.results ?? []
	if (rows.length === 0) {
		return { outcome: 'ignored', reason: 'no_held' }
	}
	let last: ReferralRewardOutcome = { outcome: 'ignored', reason: 'no_pending' }
	for (const pending of rows) {
		if (!pending.held_invoice_id) continue
		const referrerPaidPeriodEndAt = input.resolveReferrerPaidPeriodEnd
			? await input.resolveReferrerPaidPeriodEnd(
					pending.referrer_stable_user_id,
				)
			: (input.referrerPaidPeriodEndAt ?? null)
		last = await rewardReferralForPaidInvoice({
			db: input.db,
			refereeStableUserId: pending.referee_stable_user_id,
			invoiceId: pending.held_invoice_id,
			invoiceQualifies: true,
			paidPeriodEndAt: pending.held_period_end_at,
			referrerPaidPeriodEndAt,
			now: input.now,
		})
	}
	return last
}

export async function loadReferralProgramSummary(input: {
	db: D1Database
	stableUserId: string
	username: string
	origin: string
	now?: Date
}): Promise<ReferralProgramSummary> {
	const now = input.now ?? new Date()
	const creditRow = await input.db
		.prepare(
			`SELECT referral_standard_credit_expires_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(input.stableUserId)
		.first<{ referral_standard_credit_expires_at: string | null }>()
	const creditExpiresAt =
		creditRow?.referral_standard_credit_expires_at?.trim() || null
	const [rows, counts] = await Promise.all([
		input.db
			.prepare(
				`SELECT r.status, r.created_at, r.rewarded_at, u.username AS referee_username
				 FROM referrals r
				 LEFT JOIN users u ON u.stable_user_id = r.referee_stable_user_id
				 WHERE r.referrer_stable_user_id = ?
				   AND r.status IN ('pending', 'rewarded')
				 ORDER BY r.created_at DESC
				 LIMIT 50`,
			)
			.bind(input.stableUserId)
			.all<{
				status: string
				created_at: string
				rewarded_at: string | null
				referee_username: string | null
			}>(),
		input.db
			.prepare(
				`SELECT status, COUNT(*) AS total
				 FROM referrals
				 WHERE referrer_stable_user_id = ?
				   AND status IN ('pending', 'rewarded')
				 GROUP BY status`,
			)
			.bind(input.stableUserId)
			.all<{ status: string; total: number }>(),
	])
	const referrals: Array<ReferralProgramListItem> = (rows.results ?? []).map(
		(row) => ({
			refereeUsername: row.referee_username,
			status: row.status === 'rewarded' ? 'rewarded' : 'pending',
			createdAt: row.created_at,
			rewardedAt: row.rewarded_at,
		}),
	)
	const countFor = (status: string) => {
		const total = counts.results?.find((row) => row.status === status)?.total
		const parsed = typeof total === 'number' ? total : Number(total)
		return Number.isFinite(parsed) ? parsed : 0
	}
	const sharePath = referralSharePath(input.username)
	return {
		sharePath,
		shareUrl: new URL(sharePath, input.origin).toString(),
		rewardedCount: countFor('rewarded'),
		pendingCount: countFor('pending'),
		creditExpiresAt,
		creditActive: isReferralStandardCreditActive(creditExpiresAt, now),
		referrals,
	}
}

export function laterStandardOverlayExpiry(
	giftExpiresAt: string | null | undefined,
	referralExpiresAt: string | null | undefined,
): string | null {
	return laterIsoTimestamp(giftExpiresAt, referralExpiresAt)
}
