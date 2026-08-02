import {
	emailDeliveryEventRetentionDays,
	emailMessageRetentionDays,
	pruneEmailDeliveryEventsForRetention,
	pruneUserEmailMessagesForRetention,
} from '#app/retention.ts'
import { systemEmailOwnerId } from '#worker/email/email-owner.ts'
import { mailboxRpc, type MailboxEnv } from '#worker/email/mailbox-client.ts'
import {
	mailboxParityUserBatchSize,
	reconcileMailboxParity,
	type MailboxParityReconcileEnv,
	type MailboxParityReconcileMetrics,
} from '#worker/email/mailbox-reconcile.ts'
import {
	mailboxReadCutoverCheckedAtMaxAgeMs,
	mailboxReadCutoverSoakMs,
} from '#worker/email/mailbox-read-cutover.ts'
import { type MailboxCountResult } from '#worker/email/mailbox-types.ts'
import {
	loadOutboundProviderIndexParityReport,
	type OutboundProviderIndexParityReport,
} from '#worker/email/outbound-provider-index.ts'
import {
	deleteEmailMessageById,
	getEmailMessageById,
} from '#worker/email/repo.ts'

/** Cap for admin reconcile batch discovery (hard max). */
export const adminMailboxMaintenanceMaxBatchSize = 100

/** Retention owner page size default/max (hard max). */
export const adminMailboxMaintenanceRetentionMaxLimit = 20
export const adminMailboxMaintenanceRetentionDefaultLimit =
	adminMailboxMaintenanceRetentionMaxLimit

/** Max concurrent per-owner Mailbox retention RPCs. */
export const adminMailboxMaintenanceRetentionConcurrency = 4

/** Wall-clock budget for one retention action call. */
export const adminMailboxMaintenanceRetentionBudgetMs = 10_000

export type AdminMailboxMaintenanceEnv = MailboxParityReconcileEnv &
	MailboxEnv & {
		EMAIL_BLOBS: Pick<R2Bucket, 'delete' | 'head'>
	}

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
	/**
	 * Fleet-wide aggregate D1 outbound provider reverse-index parity. Counts
	 * only — no owner ids, message ids, or email content.
	 */
	outboundProviderIndex: OutboundProviderIndexParityReport
}

export type AdminMailboxMaintenanceRetentionD1Metrics = {
	messagesDeleted: number
	attachmentsDeleted: number
	threadsDeleted: number
	deliveryEventsDeleted: number
	rawMimeBlobsDeleted: number
	attachmentBlobsDeleted: number
	blobDeleteErrors: number
}

export type AdminMailboxMaintenanceRetentionMailboxMetrics = {
	ownersAttempted: number
	ownersSucceeded: number
	ownersFailed: number
	/**
	 * Owners skipped because expired D1 message/event rows remain after the
	 * global prune batches. Cursor still advances; repeated calls drain via D1.
	 */
	pendingD1Owners: number
	before: MailboxCountResult
	after: MailboxCountResult
	blobDeleteFailureOwners: number
	expiredRemainingOwners: number
}

export type AdminMailboxMaintenanceRetentionMetrics = {
	d1: AdminMailboxMaintenanceRetentionD1Metrics
	mailbox: AdminMailboxMaintenanceRetentionMailboxMetrics
}

/**
 * Aggregate-only outcome for a single audited admin message delete. Never
 * includes addresses, bodies, filenames, or R2 keys.
 */
export type AdminMailboxMaintenanceDeleteMessageResult = {
	d1MessageAbsent: boolean
	attachmentsSeen: number
	externalAttachmentsSeen: number
	rawMimeBlobAbsent: boolean
	externalAttachmentBlobsAbsent: number
	/** True when every blob key captured by deleteEmailMessageById is absent. */
	allCapturedBlobsAbsent: boolean
}

const millisecondsPerDay = 24 * 60 * 60 * 1000

/** Same ISO cutoff formula as `#app/retention` `cutoffIso`. */
export function adminEmailRetentionCutoffIso(now: Date, days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
}

/**
 * True when the owner still has natural-cutoff-expired D1 mail rows. Owners are
 * already non-system from discovery — no extra system exclusion here.
 */
export async function ownerHasPendingExpiredD1Retention(input: {
	db: D1Database
	userId: string
	now: Date
}): Promise<boolean> {
	const messageCutoff = adminEmailRetentionCutoffIso(
		input.now,
		emailMessageRetentionDays,
	)
	const eventCutoff = adminEmailRetentionCutoffIso(
		input.now,
		emailDeliveryEventRetentionDays,
	)
	const row = await input.db
		.prepare(
			`SELECT 1 AS ok
			WHERE EXISTS (
				SELECT 1 FROM email_messages
				WHERE user_id = ? AND created_at < ?
				LIMIT 1
			)
			OR EXISTS (
				SELECT 1 FROM email_delivery_events
				WHERE user_id = ? AND created_at < ?
				LIMIT 1
			)`,
		)
		.bind(input.userId, messageCutoff, input.userId, eventCutoff)
		.first<{ ok: number }>()
	return row != null
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

function clampReconcileBatchSize(batchSize: number | undefined): number {
	const requested = batchSize ?? mailboxParityUserBatchSize
	if (!Number.isFinite(requested)) return mailboxParityUserBatchSize
	return Math.max(
		1,
		Math.min(adminMailboxMaintenanceMaxBatchSize, Math.trunc(requested)),
	)
}

function clampRetentionLimit(limit: number | undefined): number {
	const requested = limit ?? adminMailboxMaintenanceRetentionDefaultLimit
	if (!Number.isFinite(requested)) {
		return adminMailboxMaintenanceRetentionDefaultLimit
	}
	return Math.max(
		1,
		Math.min(adminMailboxMaintenanceRetentionMaxLimit, Math.trunc(requested)),
	)
}

function emptyMailboxCounts(): MailboxCountResult {
	return { threads: 0, messages: 0, attachments: 0, deliveryEvents: 0 }
}

function addMailboxCounts(
	left: MailboxCountResult,
	right: MailboxCountResult,
): MailboxCountResult {
	return {
		threads: left.threads + right.threads,
		messages: left.messages + right.messages,
		attachments: left.attachments + right.attachments,
		deliveryEvents: left.deliveryEvents + right.deliveryEvents,
	}
}

/**
 * List non-deleting owners with mail/parity state ordered by stable_user_id
 * keyset (never by parity checked_at).
 */
export async function listUsersForAdminMailboxRetention(input: {
	db: D1Database
	limit: number
	startAfterUserId?: string | null
}): Promise<Array<{ userId: string }>> {
	const startAfter = input.startAfterUserId ?? null
	const result = startAfter
		? await input.db
				.prepare(
					`SELECT u.stable_user_id AS userId
					FROM users u
					WHERE ${trackedOwnerSql}
						AND u.stable_user_id > ?
					ORDER BY u.stable_user_id ASC
					LIMIT ?`,
				)
				.bind(systemEmailOwnerId, startAfter, input.limit)
				.all<{ userId: string }>()
		: await input.db
				.prepare(
					`SELECT u.stable_user_id AS userId
					FROM users u
					WHERE ${trackedOwnerSql}
					ORDER BY u.stable_user_id ASC
					LIMIT ?`,
				)
				.bind(systemEmailOwnerId, input.limit)
				.all<{ userId: string }>()
	return result.results ?? []
}

type OwnerRetentionOutcome =
	| {
			status: 'succeeded'
			before: MailboxCountResult
			after: MailboxCountResult
			blobDeleteFailures: boolean
			expiredRemaining: boolean
	  }
	| { status: 'failed' }
	| { status: 'pending_d1' }

async function runOwnersWithBudget(input: {
	owners: ReadonlyArray<{ userId: string }>
	concurrency: number
	deadlineMs: number
	nowMs: () => number
	runOwner: (userId: string) => Promise<OwnerRetentionOutcome>
}): Promise<{
	outcomes: Array<OwnerRetentionOutcome>
	lastAttemptedUserId: string | null
	stoppedByBudget: boolean
}> {
	const outcomes: Array<OwnerRetentionOutcome> = []
	let nextIndex = 0
	let inFlight = 0
	let lastAttemptedUserId: string | null = null
	let stoppedByBudget = false

	await new Promise<void>((resolve) => {
		const settleIfDone = () => {
			if (inFlight > 0) return
			resolve()
		}
		const launch = () => {
			while (
				inFlight < input.concurrency &&
				nextIndex < input.owners.length &&
				input.nowMs() < input.deadlineMs
			) {
				const owner = input.owners[nextIndex]
				if (!owner) break
				nextIndex += 1
				lastAttemptedUserId = owner.userId
				inFlight += 1
				void input
					.runOwner(owner.userId)
					.then((outcome) => {
						outcomes.push(outcome)
					})
					.catch(() => {
						// runOwner isolates failures; this is a last-resort guard.
						outcomes.push({ status: 'failed' })
					})
					.finally(() => {
						inFlight -= 1
						launch()
						settleIfDone()
					})
			}
			if (
				input.nowMs() >= input.deadlineMs &&
				nextIndex < input.owners.length
			) {
				stoppedByBudget = true
			}
			settleIfDone()
		}
		launch()
	})

	return { outcomes, lastAttemptedUserId, stoppedByBudget }
}

/**
 * Aggregate-only Mailbox parity status for operators. Never returns email
 * content, message ids, or per-owner identity (except retention cursors).
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

	const outboundProviderIndex = await loadOutboundProviderIndexParityReport({
		db: input.db,
	})

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
		outboundProviderIndex,
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
		batchSize: clampReconcileBatchSize(input.batchSize),
	})
	const status = await loadAdminMailboxMaintenanceStatus({
		db: input.env.APP_DB,
		now,
	})
	return { metrics, status }
}

/**
 * Bounded retention sweep: D1 natural-cutoff prune (authoritative blob-before-row
 * for messages), then per-owner expired-D1 checks, then Mailbox DO passes only
 * when D1 is clear for that owner. Stable-id keyset cursor; wall budget +
 * concurrency bounds; per-owner failures isolated. Pending-D1 owners skip DO
 * but still advance the cursor.
 */
export async function runAdminMailboxMaintenanceRetention(input: {
	env: AdminMailboxMaintenanceEnv
	limit?: number
	startAfterUserId?: string | null
	now?: Date
	/** Test seam for wall-clock budget. */
	budgetMs?: number
	/** Test seam for concurrency. */
	concurrency?: number
	/** Test seam for clock. */
	nowMs?: () => number
}): Promise<{
	metrics: AdminMailboxMaintenanceRetentionMetrics
	nextStartAfter: string | null
	truncated: boolean
	status: AdminMailboxMaintenanceStatus
}> {
	const now = input.now ?? new Date()
	const nowMs = input.nowMs ?? Date.now
	const budgetMs = input.budgetMs ?? adminMailboxMaintenanceRetentionBudgetMs
	const concurrency = Math.max(
		1,
		Math.min(
			adminMailboxMaintenanceRetentionConcurrency,
			input.concurrency ?? adminMailboxMaintenanceRetentionConcurrency,
		),
	)
	const limit = clampRetentionLimit(input.limit)
	const startAfterUserId = input.startAfterUserId ?? null
	const deadlineMs = nowMs() + budgetMs

	// D1 remains expand-phase authority + blob linkage. Natural cutoffs only.
	const d1Messages = await pruneUserEmailMessagesForRetention({
		db: input.env.APP_DB,
		blobs: input.env.EMAIL_BLOBS,
		now,
	})
	const d1Events = await pruneEmailDeliveryEventsForRetention({
		db: input.env.APP_DB,
		now,
	})

	const owners = await listUsersForAdminMailboxRetention({
		db: input.env.APP_DB,
		limit,
		startAfterUserId,
	})

	const { outcomes, lastAttemptedUserId, stoppedByBudget } =
		await runOwnersWithBudget({
			owners,
			concurrency,
			deadlineMs,
			nowMs,
			async runOwner(userId) {
				try {
					// Never DO/R2-delete while this owner still has expired D1 rows
					// (global oldest-first batches may have omitted them).
					if (
						await ownerHasPendingExpiredD1Retention({
							db: input.env.APP_DB,
							userId,
							now,
						})
					) {
						return { status: 'pending_d1' as const }
					}
					const result = await mailboxRpc({
						env: input.env,
						userId,
					}).runRetentionNow({ ownerId: userId })
					return {
						status: 'succeeded' as const,
						before: result.before,
						after: result.after,
						blobDeleteFailures: result.blobDeleteFailures,
						expiredRemaining: result.expiredRemaining,
					}
				} catch (error) {
					console.warn('admin-mailbox-maintenance-retention-owner-failed', {
						error,
					})
					return { status: 'failed' as const }
				}
			},
		})

	const mailbox: AdminMailboxMaintenanceRetentionMailboxMetrics = {
		ownersAttempted: 0,
		ownersSucceeded: 0,
		ownersFailed: 0,
		pendingD1Owners: 0,
		before: emptyMailboxCounts(),
		after: emptyMailboxCounts(),
		blobDeleteFailureOwners: 0,
		expiredRemainingOwners: 0,
	}
	for (const outcome of outcomes) {
		switch (outcome.status) {
			case 'pending_d1':
				mailbox.pendingD1Owners += 1
				break
			case 'failed':
				mailbox.ownersAttempted += 1
				mailbox.ownersFailed += 1
				break
			case 'succeeded':
				mailbox.ownersAttempted += 1
				mailbox.ownersSucceeded += 1
				mailbox.before = addMailboxCounts(mailbox.before, outcome.before)
				mailbox.after = addMailboxCounts(mailbox.after, outcome.after)
				if (outcome.blobDeleteFailures) mailbox.blobDeleteFailureOwners += 1
				if (outcome.expiredRemaining) mailbox.expiredRemainingOwners += 1
				break
			default: {
				const exhaustive: never = outcome
				throw new Error(
					`Unhandled retention owner outcome: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	}

	const pageFull = owners.length >= limit
	const truncated = stoppedByBudget || pageFull
	const nextStartAfter = truncated
		? (lastAttemptedUserId ?? startAfterUserId)
		: null

	const status = await loadAdminMailboxMaintenanceStatus({
		db: input.env.APP_DB,
		now,
	})

	return {
		metrics: {
			d1: {
				messagesDeleted: d1Messages.deletedMessages,
				attachmentsDeleted: d1Messages.deletedAttachments,
				threadsDeleted: d1Messages.deletedThreads,
				deliveryEventsDeleted: d1Events.deleted,
				rawMimeBlobsDeleted: d1Messages.deletedRawMimeBlobs,
				attachmentBlobsDeleted: d1Messages.deletedAttachmentBlobs,
				blobDeleteErrors: d1Messages.blobDeleteErrors,
			},
			mailbox,
		},
		nextStartAfter,
		truncated,
		status,
	}
}

/**
 * Missing or foreign target for owner-scoped canary delete. Callers supplied
 * an id that does not resolve under the given owner fence — not a platform
 * defect. The MCP capability maps this to `McpCallerError` so it stays on
 * `mcp-event` and out of Sentry.
 */
export class AdminMailboxMessageNotFoundError extends Error {
	constructor(input: { stableUserId: string; messageId: string }) {
		super(
			`Email message not found for stable_user_id=${input.stableUserId} message_id=${input.messageId}`,
		)
		this.name = 'AdminMailboxMessageNotFoundError'
	}
}

/**
 * Owner-scoped single-message delete for accelerated Mailbox coverage canaries.
 * Verifies ownership via getEmailMessageById, deletes through
 * deleteEmailMessageById with an expectedUserId fence, then confirms D1
 * absence plus every exact captured blob key absent via head. Rejects missing
 * or foreign messages.
 */
export async function runAdminMailboxMaintenanceDeleteMessage(input: {
	env: AdminMailboxMaintenanceEnv
	stableUserId: string
	messageId: string
}): Promise<AdminMailboxMaintenanceDeleteMessageResult> {
	const db = input.env.APP_DB
	const blobs = input.env.EMAIL_BLOBS
	const message = await getEmailMessageById({
		db,
		userId: input.stableUserId,
		messageId: input.messageId,
	})
	if (!message) {
		throw new AdminMailboxMessageNotFoundError({
			stableUserId: input.stableUserId,
			messageId: input.messageId,
		})
	}

	const deletion = await deleteEmailMessageById({
		db,
		blobs: blobs as R2Bucket,
		messageId: message.id,
		expectedUserId: input.stableUserId,
	})

	const remaining = await getEmailMessageById({
		db,
		userId: input.stableUserId,
		messageId: message.id,
	})
	const d1MessageAbsent = remaining == null

	const rawMimeEntries = deletion.blobDeletions.filter(
		(entry) => entry.role === 'raw_mime',
	)
	const attachmentEntries = deletion.blobDeletions.filter(
		(entry) => entry.role === 'attachment',
	)
	let rawMimeBlobAbsent = true
	for (const entry of rawMimeEntries) {
		if ((await blobs.head(entry.key)) != null) {
			rawMimeBlobAbsent = false
		}
	}
	let externalAttachmentBlobsAbsent = 0
	for (const entry of attachmentEntries) {
		if ((await blobs.head(entry.key)) == null) {
			externalAttachmentBlobsAbsent += 1
		}
	}
	const allCapturedBlobsAbsent =
		rawMimeBlobAbsent &&
		externalAttachmentBlobsAbsent === attachmentEntries.length

	return {
		d1MessageAbsent,
		attachmentsSeen: deletion.attachmentsSeen,
		externalAttachmentsSeen: deletion.externalAttachmentsSeen,
		rawMimeBlobAbsent,
		externalAttachmentBlobsAbsent,
		allCapturedBlobsAbsent,
	}
}
