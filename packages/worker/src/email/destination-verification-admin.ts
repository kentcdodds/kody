import {
	loadAdminUserByTarget,
	loadAdminUserRowByStableUserId,
	type AdminUserListItem,
	type AdminUserTarget,
} from '#worker/admin/users-data.ts'
import { assertAccountWritableDb } from '#worker/account/deletion-state.ts'
import { normalizeEmailAddress } from './address.ts'
import {
	markEmailNotificationDestinationVerified,
	type EmailNotificationDestination,
} from './destinations.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export class AdminEmailDestinationVerificationError extends Error {
	readonly code: 'not_found' | 'already_verified' | 'invalid_email'

	constructor(
		code: 'not_found' | 'already_verified' | 'invalid_email',
		message: string,
	) {
		super(message)
		this.name = 'AdminEmailDestinationVerificationError'
		this.code = code
	}
}

/**
 * Operator unblock for destination verification when mail never arrives
 * (strict DMARC receivers, silent provider drops). Audited by the caller.
 */
export async function markAdminEmailDestinationVerified(input: {
	db: D1Database
	target: AdminUserTarget
	destinationEmail: string
	now?: Date
}): Promise<{
	user: AdminUserListItem
	destination: EmailNotificationDestination
}> {
	const destinationEmail = normalizeEmailAddress(input.destinationEmail)
	if (!destinationEmail) {
		throw new AdminEmailDestinationVerificationError(
			'invalid_email',
			'Enter a valid destination email address.',
		)
	}

	const existing = await loadAdminUserByTarget(input.db, input.target)
	if (!existing) {
		throw new AdminEmailDestinationVerificationError(
			'not_found',
			'User not found.',
		)
	}
	const existingRow = await loadAdminUserRowByStableUserId(
		input.db,
		existing.stableUserId,
	)
	if (!existingRow) {
		throw new AdminEmailDestinationVerificationError(
			'not_found',
			'User not found.',
		)
	}
	await assertAccountWritableDb(input.db, existing.stableUserId)

	const row = await input.db
		.prepare(
			`SELECT id, email, verified_at, is_default
			 FROM email_notification_destinations
			 WHERE user_id = ? AND lower(email) = ?${andLiveDeletedAtSql()}`,
		)
		.bind(existingRow.id, destinationEmail)
		.first<{
			id: string
			email: string
			verified_at: string | null
			is_default: number
		}>()
	if (!row) {
		throw new AdminEmailDestinationVerificationError(
			'not_found',
			'Email destination was not found for that account.',
		)
	}
	if (row.verified_at) {
		throw new AdminEmailDestinationVerificationError(
			'already_verified',
			'That email destination is already verified.',
		)
	}

	const destination = await markEmailNotificationDestinationVerified({
		db: input.db,
		destinationId: row.id,
		userId: existingRow.id,
		now: input.now,
	})
	if (!destination) {
		throw new AdminEmailDestinationVerificationError(
			'not_found',
			'Email destination was not found for that account.',
		)
	}

	await input.db
		.prepare(
			`DELETE FROM pending_email_destination_verifications
			 WHERE destination_id = ?`,
		)
		.bind(row.id)
		.run()
		.catch(() => undefined)

	return { user: existing, destination }
}
