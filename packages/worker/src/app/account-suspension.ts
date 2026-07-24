/**
 * Platform account suspension and outbound-email pause reads.
 *
 * `users.suspended_at` is an operator-set kill switch checked at the
 * browser-session, MCP, and email chokepoints (unlike a community ban,
 * which only blocks community-surface actions). `users.email_outbound_paused_at`
 * is the automatic outbound-email pause set by the delivery-event abuse
 * monitor (see `#worker/email/outbound-abuse.ts`); both are cleared by an
 * admin from the admin users page.
 */

import { normalizeEmail } from '#app/normalize-email.ts'
import { normalizeStableUserId } from '#worker/user-id.ts'

export const accountSuspendedMessage =
	'This account is suspended. Contact the operator of this Kody deployment to appeal.'

export type AccountRestrictions = {
	suspendedAt: string | null
	emailOutboundPausedAt: string | null
}

/**
 * Read the restriction flags for the account behind a stable MCP userId.
 * Returns null when no account matches (callers already fail closed on
 * unknown accounts through their own identity gates).
 */
export async function getAccountRestrictionsByStableUserId(input: {
	db: D1Database
	stableUserId: string
}): Promise<AccountRestrictions | null> {
	const stableUserId = normalizeStableUserId(input.stableUserId)
	if (!stableUserId) return null
	const row = await input.db
		.prepare(
			`SELECT suspended_at, email_outbound_paused_at FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(stableUserId)
		.first<{
			suspended_at: string | null
			email_outbound_paused_at: string | null
		}>()
	if (!row) return null
	return {
		suspendedAt: row.suspended_at,
		emailOutboundPausedAt: row.email_outbound_paused_at,
	}
}

/**
 * Whether the account is suspended, resolved the same way as
 * `isAccountEmailVerified`: when both the email and the stable id are
 * present (typical MCP grant props) the pair must match one row, so a
 * stale grant email owned by another account can never be consulted.
 */
export async function isAccountSuspended(input: {
	db: D1Database
	email?: string | null
	stableUserId?: string | null
}): Promise<boolean> {
	const normalizedEmail =
		typeof input.email === 'string' ? normalizeEmail(input.email) : ''
	const stableUserId = input.stableUserId?.trim() ?? ''

	if (normalizedEmail && stableUserId) {
		const row = await input.db
			.prepare(
				`SELECT suspended_at FROM users
				 WHERE email = ? AND stable_user_id = ?`,
			)
			.bind(normalizedEmail, stableUserId)
			.first<{ suspended_at: string | null }>()
		return Boolean(row?.suspended_at)
	}

	if (normalizedEmail) {
		const row = await input.db
			.prepare(`SELECT suspended_at FROM users WHERE email = ?`)
			.bind(normalizedEmail)
			.first<{ suspended_at: string | null }>()
		return Boolean(row?.suspended_at)
	}

	if (!stableUserId) return false
	const row = await input.db
		.prepare(`SELECT suspended_at FROM users WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<{ suspended_at: string | null }>()
	return Boolean(row?.suspended_at)
}
