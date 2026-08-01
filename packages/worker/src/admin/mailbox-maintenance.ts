import { systemEmailOwnerId } from '#worker/email/email-owner.ts'
import { mailboxRpc, type MailboxEnv } from '#worker/email/mailbox-client.ts'
import {
	mailboxParityUserBatchSize,
	reconcileMailboxParity,
	type MailboxParityReconcileEnv,
	type MailboxParityReconcileMetrics,
} from '#worker/email/mailbox-reconcile.ts'
import { listUsersForMailboxParity } from '#worker/email/mailbox-parity-repo.ts'
import {
	mailboxReadCutoverCheckedAtMaxAgeMs,
	mailboxReadCutoverSoakMs,
} from '#worker/email/mailbox-read-cutover.ts'

/** Cap for admin reconcile/retention batch discovery (hard max). */
export const adminMailboxMaintenanceMaxBatchSize = 100

export type AdminMailboxMaintenanceEnv = MailboxParityReconcileEnv & MailboxEnv

export type AdminMailboxMaintenanceStatus = {
	generatedAt: string
	trackedOwners: number
	matching: number
	mismatch: number
	error: number
	incomplete: number
	eligible: number
	oldestMatchingSince: string | null
	newestMatchingSince: string | null
	oldestCheckedAt: string | null
	newestCheckedAt: string | null
	/** Earliest `matching_since + soak` among matching owners (null if none). */
	earliestCutoverAt: string | null
}

export type AdminMailboxMaintenanceRetentionMetrics = {
	ownersAttempted: number
	ownersSucceeded: number
	ownersFailed: number
	messagesDeleted: number
	threadsDeleted: number
	attachmentsDeleted: number
	deliveryEventsDeleted: number
	blobDeleteFailureOwners: number
	expiredRemainingOwners: number
}

const trackedOwnerSql = `
	u.deleting_at IS NULL
	AND u.stable_user_id != ?
	AND (
		EXISTS (
			SELECT 1 FROM email_messages m
			WHERE m.user_id = u.stable_user_id
		)
		OR EXISTS (
			SELECT 1 FROM email_delivery_events e
			WHERE e.user_id = u.stable_user_id
		)
		OR u.mailbox_parity_checked_at IS NOT NULL
		OR u.mailbox_parity_matching_since IS NOT NULL
		OR u.mailbox_parity_last_error IS NOT NULL
		OR u.mailbox_parity_mismatch_count > 0
		OR u.mailbox_parity_content_watermark_at IS NOT NULL
		OR u.mailbox_parity_content_replay_upper_at IS NOT NULL
		OR u.mailbox_parity_content_replay_cursor_id IS NOT NULL
		OR u.mailbox_parity_message_backfill_cursor_id IS NOT NULL
		OR u.mailbox_parity_message_backfill_completed_at IS NOT NULL
		OR u.mailbox_parity_event_backfill_cursor_id IS NOT NULL
		OR u.mailbox_parity_event_backfill_completed_at IS NOT NULL
	)
`

function clampBatchSize(batchSize: number | undefined): number {
	const requested = batchSize ?? mailboxParityUserBatchSize
	if (!Number.isFinite(requested)) return mailboxParityUserBatchSize
	return Math.max(
		1,
		Math.min(adminMailboxMaintenanceMaxBatchSize, Math.trunc(requested)),
	)
}

function countDelta(before: number, after: number): number {
	return Math.max(0, before - after)
}

/**
 * Aggregate-only Mailbox parity status for operators. Never returns email
 * content, message ids, or per-owner identity.
 */
export async function loadAdminMailboxMaintenanceStatus(input: {
	db: D1Database
	now?: Date
}): Promise<AdminMailboxMaintenanceStatus> {
	const now = input.now ?? new Date()
	const generatedAt = now.toISOString()
	const nowMs = now.getTime()
	const soakCutoffIso = new Date(nowMs - mailboxReadCutoverSoakMs).toISOString()
	const checkedAtMinIso = new Date(
		nowMs - mailboxReadCutoverCheckedAtMaxAgeMs,
	).toISOString()

	const row = await input.db
		.prepare(
			`SELECT
				COUNT(*) AS trackedOwners,
				SUM(
					CASE
						WHEN u.mailbox_parity_last_error IS NOT NULL THEN 1
						ELSE 0
					END
				) AS errorCount,
				SUM(
					CASE
						WHEN u.mailbox_parity_last_error IS NULL
							AND u.mailbox_parity_mismatch_count > 0
						THEN 1
						ELSE 0
					END
				) AS mismatchCount,
				SUM(
					CASE
						WHEN u.mailbox_parity_last_error IS NULL
							AND u.mailbox_parity_mismatch_count = 0
							AND u.mailbox_parity_matching_since IS NOT NULL
							AND u.mailbox_parity_message_backfill_completed_at IS NOT NULL
							AND u.mailbox_parity_event_backfill_completed_at IS NOT NULL
							AND u.mailbox_parity_content_replay_upper_at IS NULL
						THEN 1
						ELSE 0
					END
				) AS matchingCount,
				SUM(
					CASE
						WHEN u.mailbox_parity_last_error IS NULL
							AND u.mailbox_parity_mismatch_count = 0
							AND (
								u.mailbox_parity_matching_since IS NULL
								OR u.mailbox_parity_message_backfill_completed_at IS NULL
								OR u.mailbox_parity_event_backfill_completed_at IS NULL
								OR u.mailbox_parity_content_replay_upper_at IS NOT NULL
							)
						THEN 1
						ELSE 0
					END
				) AS incompleteCount,
				SUM(
					CASE
						WHEN u.mailbox_parity_last_error IS NULL
							AND u.mailbox_parity_mismatch_count = 0
							AND u.mailbox_parity_matching_since IS NOT NULL
							AND u.mailbox_parity_matching_since <= ?
							AND u.mailbox_parity_matching_since <= ?
							AND u.mailbox_parity_checked_at IS NOT NULL
							AND u.mailbox_parity_checked_at >= ?
							AND u.mailbox_parity_checked_at <= ?
						THEN 1
						ELSE 0
					END
				) AS eligibleCount,
				MIN(u.mailbox_parity_matching_since) AS oldestMatchingSince,
				MAX(u.mailbox_parity_matching_since) AS newestMatchingSince,
				MIN(u.mailbox_parity_checked_at) AS oldestCheckedAt,
				MAX(u.mailbox_parity_checked_at) AS newestCheckedAt,
				MIN(
					CASE
						WHEN u.mailbox_parity_last_error IS NULL
							AND u.mailbox_parity_mismatch_count = 0
							AND u.mailbox_parity_matching_since IS NOT NULL
						THEN u.mailbox_parity_matching_since
						ELSE NULL
					END
				) AS earliestMatchingSinceForCutover
			FROM users u
			WHERE ${trackedOwnerSql}`,
		)
		.bind(
			soakCutoffIso,
			generatedAt,
			checkedAtMinIso,
			generatedAt,
			systemEmailOwnerId,
		)
		.first<{
			trackedOwners: number
			errorCount: number | null
			mismatchCount: number | null
			matchingCount: number | null
			incompleteCount: number | null
			eligibleCount: number | null
			oldestMatchingSince: string | null
			newestMatchingSince: string | null
			oldestCheckedAt: string | null
			newestCheckedAt: string | null
			earliestMatchingSinceForCutover: string | null
		}>()

	const earliestMatchingSince = row?.earliestMatchingSinceForCutover ?? null
	let earliestCutoverAt: string | null = null
	if (earliestMatchingSince != null) {
		const matchingMs = Date.parse(earliestMatchingSince)
		if (Number.isFinite(matchingMs)) {
			earliestCutoverAt = new Date(
				matchingMs + mailboxReadCutoverSoakMs,
			).toISOString()
		}
	}

	return {
		generatedAt,
		trackedOwners: Number(row?.trackedOwners ?? 0) || 0,
		matching: Number(row?.matchingCount ?? 0) || 0,
		mismatch: Number(row?.mismatchCount ?? 0) || 0,
		error: Number(row?.errorCount ?? 0) || 0,
		incomplete: Number(row?.incompleteCount ?? 0) || 0,
		eligible: Number(row?.eligibleCount ?? 0) || 0,
		oldestMatchingSince: row?.oldestMatchingSince ?? null,
		newestMatchingSince: row?.newestMatchingSince ?? null,
		oldestCheckedAt: row?.oldestCheckedAt ?? null,
		newestCheckedAt: row?.newestCheckedAt ?? null,
		earliestCutoverAt,
	}
}

export async function runAdminMailboxMaintenanceReconcile(input: {
	env: AdminMailboxMaintenanceEnv
	batchSize?: number
	now?: Date
}): Promise<{
	metrics: MailboxParityReconcileMetrics
	status: AdminMailboxMaintenanceStatus
}> {
	const now = input.now ?? new Date()
	const metrics = await reconcileMailboxParity({
		env: input.env,
		now,
		batchSize: clampBatchSize(input.batchSize),
	})
	const status = await loadAdminMailboxMaintenanceStatus({
		db: input.env.APP_DB,
		now,
	})
	return { metrics, status }
}

/**
 * Bounded D1-discovered retention sweep. Calls owner-bound
 * `Mailbox.runRetentionNow` (natural cutoffs only). Aggregates counts without
 * owner ids, message ids, or email content.
 */
export async function runAdminMailboxMaintenanceRetention(input: {
	env: AdminMailboxMaintenanceEnv
	batchSize?: number
	now?: Date
}): Promise<{
	metrics: AdminMailboxMaintenanceRetentionMetrics
	status: AdminMailboxMaintenanceStatus
}> {
	const now = input.now ?? new Date()
	const owners = await listUsersForMailboxParity({
		db: input.env.APP_DB,
		limit: clampBatchSize(input.batchSize),
	})

	const metrics: AdminMailboxMaintenanceRetentionMetrics = {
		ownersAttempted: 0,
		ownersSucceeded: 0,
		ownersFailed: 0,
		messagesDeleted: 0,
		threadsDeleted: 0,
		attachmentsDeleted: 0,
		deliveryEventsDeleted: 0,
		blobDeleteFailureOwners: 0,
		expiredRemainingOwners: 0,
	}

	for (const { userId } of owners) {
		metrics.ownersAttempted += 1
		try {
			const result = await mailboxRpc({
				env: input.env,
				userId,
			}).runRetentionNow({ ownerId: userId })
			metrics.ownersSucceeded += 1
			metrics.messagesDeleted += countDelta(
				result.before.messages,
				result.after.messages,
			)
			metrics.threadsDeleted += countDelta(
				result.before.threads,
				result.after.threads,
			)
			metrics.attachmentsDeleted += countDelta(
				result.before.attachments,
				result.after.attachments,
			)
			metrics.deliveryEventsDeleted += countDelta(
				result.before.deliveryEvents,
				result.after.deliveryEvents,
			)
			if (result.blobDeleteFailures) metrics.blobDeleteFailureOwners += 1
			if (result.expiredRemaining) metrics.expiredRemainingOwners += 1
		} catch (error) {
			metrics.ownersFailed += 1
			console.warn('admin-mailbox-maintenance-retention-owner-failed', {
				error,
			})
		}
	}

	const status = await loadAdminMailboxMaintenanceStatus({
		db: input.env.APP_DB,
		now,
	})
	return { metrics, status }
}
