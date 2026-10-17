/**
 * Auto-pause user/agent outbound mail after N consecutive terminal delivery
 * failures. Distinct from the abuse pause (spam complaints / bounce burst):
 * owners can resume this pause from account email settings.
 */

import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { type EmailDeliveryStatus } from './types.ts'

export const outboundConsecutiveFailurePauseThreshold = 5

export const emailOutboundDeliveryPausedMessage =
	'Outbound email is paused after repeated delivery failures. Resume sending from Account → Email once the destination can receive mail from kody.codes again.'

const terminalFailureStatuses = new Set<EmailDeliveryStatus>([
	'bounced',
	'failed',
	'rejected',
	'complained',
])

export async function applyOutboundConsecutiveFailureTracking(input: {
	db: D1Database
	/** Personal-org / mailbox owner id (orgs.id). */
	ownerId: OwnerId
	deliveryStatus: EmailDeliveryStatus
	now?: Date
}): Promise<{ paused: boolean; consecutiveFailures: number }> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()

	if (input.deliveryStatus === 'delivered') {
		await input.db
			.prepare(
				`UPDATE orgs
				 SET email_outbound_consecutive_failures = 0,
				     updated_at = ?
				 WHERE id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(nowIso, input.ownerId)
			.run()
		return { paused: false, consecutiveFailures: 0 }
	}

	if (!terminalFailureStatuses.has(input.deliveryStatus)) {
		return { paused: false, consecutiveFailures: 0 }
	}

	// Atomic increment so concurrent queue consumers cannot both read N and
	// write N+1 (missing the pause threshold).
	const increment = await input.db
		.prepare(
			`UPDATE orgs
			 SET email_outbound_consecutive_failures =
			       email_outbound_consecutive_failures + 1,
			     updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}
			 RETURNING email_outbound_consecutive_failures,
			           email_outbound_delivery_paused_at`,
		)
		.bind(nowIso, input.ownerId)
		.first<{
			email_outbound_consecutive_failures: number
			email_outbound_delivery_paused_at: string | null
		}>()
	if (!increment) return { paused: false, consecutiveFailures: 0 }

	const nextCount = Number(increment.email_outbound_consecutive_failures ?? 0)
	if (
		nextCount < outboundConsecutiveFailurePauseThreshold ||
		increment.email_outbound_delivery_paused_at
	) {
		return {
			paused: Boolean(increment.email_outbound_delivery_paused_at),
			consecutiveFailures: nextCount,
		}
	}

	// Require the count to still be at the threshold so a concurrent
	// delivered reset cannot leave a stale pause after clearing failures.
	const pause = await input.db
		.prepare(
			`UPDATE orgs
			 SET email_outbound_delivery_paused_at = ?,
			     updated_at = ?
			 WHERE id = ?
			   AND email_outbound_delivery_paused_at IS NULL
			   AND email_outbound_consecutive_failures >= ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			nowIso,
			nowIso,
			input.ownerId,
			outboundConsecutiveFailurePauseThreshold,
		)
		.run()
	const paused = Number(pause.meta.changes ?? 0) > 0
	if (paused) {
		console.warn('email-outbound-delivery-paused', {
			consecutiveFailures: nextCount,
			deliveryStatus: input.deliveryStatus,
		})
	}
	return { paused, consecutiveFailures: nextCount }
}

export async function clearOutboundDeliveryPause(input: {
	db: D1Database
	ownerId: OwnerId
	now?: Date
}): Promise<boolean> {
	const nowIso = (input.now ?? new Date()).toISOString()
	const result = await input.db
		.prepare(
			`UPDATE orgs
			 SET email_outbound_delivery_paused_at = NULL,
			     email_outbound_consecutive_failures = 0,
			     updated_at = ?
			 WHERE id = ? AND email_outbound_delivery_paused_at IS NOT NULL${andLiveDeletedAtSql()}`,
		)
		.bind(nowIso, input.ownerId)
		.run()
	return Number(result.meta.changes ?? 0) > 0
}

export async function loadOutboundDeliveryPause(input: {
	db: D1Database
	ownerId: OwnerId
}): Promise<{
	pausedAt: string | null
	consecutiveFailures: number
} | null> {
	const row = await input.db
		.prepare(
			`SELECT email_outbound_delivery_paused_at, email_outbound_consecutive_failures
			 FROM orgs
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.ownerId)
		.first<{
			email_outbound_delivery_paused_at: string | null
			email_outbound_consecutive_failures: number
		}>()
	if (!row) return null
	return {
		pausedAt: row.email_outbound_delivery_paused_at,
		consecutiveFailures: Number(row.email_outbound_consecutive_failures ?? 0),
	}
}
