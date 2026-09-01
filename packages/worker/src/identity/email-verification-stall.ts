import { emailVerificationStallAfterMinutes } from '#universal/email-verification-delivery.ts'

export { emailVerificationStallAfterMinutes }

export const emailVerificationStallScanLimit = 50

export function emailVerificationStallCutoffIso(
	now: Date,
	stallAfterMinutes = emailVerificationStallAfterMinutes,
) {
	return new Date(now.getTime() - stallAfterMinutes * 60_000).toISOString()
}

/**
 * Shared WHERE fragment for the hourly scan and the admin users list.
 * Bind the cutoff ISO timestamp as the single `?`.
 */
export function emailVerificationStallSqlConditions() {
	return [
		'email_verified_at IS NULL',
		'deleting_at IS NULL',
		`COALESCE(account_type, 'person') = 'person'`,
		`email_verification_delivery_status = 'accepted'`,
		'email_verification_delivery_at IS NOT NULL',
		'email_verification_delivery_at <= ?',
	] as const
}
