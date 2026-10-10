import { emailVerificationStallAfterMinutes } from '#universal/email-verification-delivery.ts'
import { personUserRowSql } from '#worker/identity/person-user-rows.ts'

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
export function emailVerificationStallSqlConditions(tableAlias?: string) {
	const column = (name: string) => (tableAlias ? `${tableAlias}.${name}` : name)
	return [
		`${column('email_verified_at')} IS NULL`,
		`${column('deleting_at')} IS NULL`,
		personUserRowSql(tableAlias),
		`${column('email_verification_delivery_status')} = 'accepted'`,
		`${column('email_verification_delivery_at')} IS NOT NULL`,
		`${column('email_verification_delivery_at')} <= ?`,
	] as const
}
