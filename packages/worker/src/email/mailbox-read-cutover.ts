/**
 * Default-off, parity-gated Mailbox read cutover for owner-facing reads.
 *
 * Gate requires both:
 * 1. feature flag `mailbox-read-cutover` enabled for the numeric `users.id`
 * 2. per-user parity soak on `users`: `mailbox_parity_matching_since` at least
 *    {@link mailboxReadCutoverSoakMs} old, `mailbox_parity_checked_at` fresh
 *    within {@link mailboxReadCutoverCheckedAtMaxAgeMs},
 *    `mailbox_parity_mismatch_count === 0`, and `stable_user_id` exact match
 *
 * D1 errors, missing/incomplete parity state, and an off flag all fail closed
 * to D1-authoritative reads. When the gate is on, Mailbox DO errors propagate
 * with no D1 fallback (fallback would hide parity bugs).
 *
 * Soak window is pre-launch 2h (not 24h): continuous exact D1↔Mailbox counts
 * across the ~38-user fleet plus every-5m parity and fail-closed freshness /
 * mismatch / deleting / identity checks were Kent-approved as sufficient before
 * launch. TODO(launch-hardening): revisit extending soak when the fleet grows.
 *
 * Live adapters record `mailbox-read-cutover` exposure once per memoized gate
 * evaluation. App callers that already ran the session flag cache pass
 * `skipExposureRecording: true` so exposures are not duplicated.
 */

import {
	recordFeatureFlagExposures,
	type FeatureFlagExposureEnv,
} from '#worker/feature-flags/exposure.ts'
import { evaluateFeatureFlag } from '#worker/feature-flags/service.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	mailboxAttachmentToEmailAttachmentRecord,
	mailboxDeliveryEventToEmailDeliveryEventRecord,
	mailboxMessageToEmailMessageRecord,
} from './mailbox-record-mappers.ts'
import {
	getEmailAttachmentRecordById,
	getEmailMessageById,
	listEmailAttachmentsForUserMessage,
	listEmailDeliveryEvents,
	listEmailMessages,
	listEmailMessagesPageForUser,
	searchEmailMessages,
} from './repo.ts'
import { loadEmailAttachmentContent, loadRawMime } from './service.ts'
import {
	type EmailAttachmentRecord,
	type EmailClassification,
	type EmailDeliveryEventRecord,
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailMessageRecord,
	type EmailProcessingStatus,
} from './types.ts'

/**
 * Continuous exact parity must hold at least this long before cutover.
 *
 * Pre-launch evidence (Kent-approved): ~38-user fleet with continuous exact
 * D1↔Mailbox counts, every-5m parity lane, and fail-closed freshness /
 * mismatch / deleting / identity checks. 2h is intentional for pre-launch
 * cutover speed — not a post-launch default.
 *
 * TODO(launch-hardening): revisit lengthening this soak before/at broader
 * launch when fleet size and mail volume invalidate the 38-user evidence.
 */
export const mailboxReadCutoverSoakMs = 2 * 60 * 60 * 1000

/**
 * Parity `checked_at` must be newer than this. Sized for the every-5m parity
 * lane with bounded batch scaling (not a strict 5m SLA).
 */
export const mailboxReadCutoverCheckedAtMaxAgeMs = 6 * 60 * 60 * 1000

export const mailboxReadCutoverFlagKey = 'mailbox-read-cutover' as const

type MailboxParityStateRow = {
	stable_user_id: string
	mailbox_parity_matching_since: string | null
	mailbox_parity_checked_at: string | null
	mailbox_parity_mismatch_count: number
}

export type MailboxReadCutoverEnv = MailboxEnv &
	FeatureFlagExposureEnv & {
		APP_DB: D1Database
		EMAIL_BLOBS?: R2Bucket
	}

/** Caller-owned memo so one request/handler records exposure at most once. */
export type MailboxReadCutoverMemo = {
	gatePromise?: Promise<boolean>
}

/**
 * Resolve an optional clock override. `undefined` uses wall clock; invalid
 * Date/string values return null so the gate fails closed (never Date.now()).
 */
function resolveNowMs(now?: Date | string): number | null {
	if (now === undefined) return Date.now()
	if (now instanceof Date) {
		const ms = now.getTime()
		return Number.isFinite(ms) ? ms : null
	}
	const parsed = Date.parse(now)
	return Number.isFinite(parsed) ? parsed : null
}

async function resolveDbUserId(
	db: D1Database,
	stableUserId: string,
): Promise<number | null> {
	const row = await db
		.prepare(`SELECT id FROM users WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<{ id: number }>()
	return row?.id ?? null
}

async function evaluateCutoverGate(input: {
	env: MailboxReadCutoverEnv
	dbUserId: number
	stableUserId: string
	now?: Date | string
	skipExposureRecording?: boolean
}): Promise<boolean> {
	try {
		const flagEvaluation = await evaluateFeatureFlag(
			input.env.APP_DB,
			mailboxReadCutoverFlagKey,
			input.dbUserId,
		)
		if (!input.skipExposureRecording) {
			await recordFeatureFlagExposures(input.env, {
				stableUserId: input.stableUserId,
				evaluations: { [mailboxReadCutoverFlagKey]: flagEvaluation },
			})
		}
		if (!flagEvaluation.enabled) return false

		const row = await input.env.APP_DB.prepare(
			`SELECT stable_user_id,
					mailbox_parity_matching_since,
					mailbox_parity_checked_at,
					mailbox_parity_mismatch_count
				FROM users
				WHERE id = ?
					AND deleting_at IS NULL`,
		)
			.bind(input.dbUserId)
			.first<MailboxParityStateRow>()

		// Missing row includes deleting accounts (`deleting_at IS NOT NULL`).
		if (!row) return false
		if (row.stable_user_id !== input.stableUserId) return false
		if (row.mailbox_parity_mismatch_count !== 0) return false
		if (
			row.mailbox_parity_matching_since == null ||
			row.mailbox_parity_checked_at == null
		) {
			return false
		}

		const matchingSinceMs = Date.parse(row.mailbox_parity_matching_since)
		const checkedAtMs = Date.parse(row.mailbox_parity_checked_at)
		if (!Number.isFinite(matchingSinceMs) || !Number.isFinite(checkedAtMs)) {
			return false
		}

		const nowMs = resolveNowMs(input.now)
		if (nowMs === null) return false
		// Future timestamps are not trustworthy (clock skew / bad writes).
		if (matchingSinceMs > nowMs) return false
		if (checkedAtMs > nowMs) return false
		if (nowMs - matchingSinceMs < mailboxReadCutoverSoakMs) return false
		if (nowMs - checkedAtMs > mailboxReadCutoverCheckedAtMaxAgeMs) return false

		return true
	} catch {
		return false
	}
}

/**
 * Fail-closed cutover eligibility for one account.
 * Never throws: D1 / flag evaluation failures return false.
 * Records flag exposure once per memo (unless request session cache already did).
 */
export async function isMailboxReadCutoverEnabled(input: {
	env: MailboxReadCutoverEnv
	dbUserId: number
	stableUserId: string
	now?: Date | string
	/**
	 * When true, skip FLAG_EXPOSURES write (caller already recorded via the
	 * session/MCP evaluation cache).
	 */
	skipExposureRecording?: boolean
	memo?: MailboxReadCutoverMemo
}): Promise<boolean> {
	if (input.memo?.gatePromise) return input.memo.gatePromise
	const promise = evaluateCutoverGate(input)
	if (input.memo) input.memo.gatePromise = promise
	return promise
}

type OwnerReadBase = {
	env: MailboxReadCutoverEnv
	dbUserId: number
	stableUserId: string
	now?: Date | string
	skipExposureRecording?: boolean
	memo?: MailboxReadCutoverMemo
}

async function useMailboxReads(input: OwnerReadBase): Promise<boolean> {
	return isMailboxReadCutoverEnabled(input)
}

/** Owner-scoped message get. Selects D1 or Mailbox via the cutover gate. */
export async function getOwnerEmailMessageById(
	input: OwnerReadBase & { messageId: string },
): Promise<EmailMessageRecord | null> {
	const useMailbox = await useMailboxReads(input)
	if (!useMailbox) {
		return getEmailMessageById({
			db: input.env.APP_DB,
			userId: input.stableUserId,
			messageId: input.messageId,
		})
	}

	const message = await mailboxRpc({
		env: input.env,
		userId: input.stableUserId,
	}).getMessage({ messageId: input.messageId })

	if (!message) return null
	return mailboxMessageToEmailMessageRecord(message, input.stableUserId)
}

export async function listOwnerEmailMessages(
	input: OwnerReadBase & {
		inboxId?: string | null
		direction?: EmailDirection | null
		processingStatus?: EmailProcessingStatus | null
		deliveryStatus?: EmailDeliveryStatus | null
		classification?: EmailClassification | null
		limit: number
	},
): Promise<Array<EmailMessageRecord>> {
	const useMailbox = await useMailboxReads(input)
	if (!useMailbox) {
		return listEmailMessages({
			db: input.env.APP_DB,
			userId: input.stableUserId,
			inboxId: input.inboxId,
			direction: input.direction,
			processingStatus: input.processingStatus,
			deliveryStatus: input.deliveryStatus,
			classification: input.classification,
			limit: input.limit,
		})
	}

	const listed = await mailboxRpc({
		env: input.env,
		userId: input.stableUserId,
	}).listMessages({
		inboxId: input.inboxId,
		direction: input.direction,
		processingStatus: input.processingStatus,
		deliveryStatus: input.deliveryStatus,
		classification: input.classification,
		limit: input.limit,
	})
	return listed.messages.map((message) =>
		mailboxMessageToEmailMessageRecord(message, input.stableUserId),
	)
}

export async function searchOwnerEmailMessages(
	input: OwnerReadBase & {
		query: string
		inboxId?: string | null
		direction?: EmailDirection | null
		processingStatus?: EmailProcessingStatus | null
		deliveryStatus?: EmailDeliveryStatus | null
		classification?: EmailClassification | null
		limit: number
	},
): Promise<Array<EmailMessageRecord>> {
	const useMailbox = await useMailboxReads(input)
	if (!useMailbox) {
		// D1 search has no classification filter; callers that need it use
		// listOwnerEmailMessagesPage (account inbox) or list with filters.
		return searchEmailMessages({
			db: input.env.APP_DB,
			userId: input.stableUserId,
			query: input.query,
			inboxId: input.inboxId,
			direction: input.direction,
			processingStatus: input.processingStatus,
			deliveryStatus: input.deliveryStatus,
			limit: input.limit,
		})
	}

	const searched = await mailboxRpc({
		env: input.env,
		userId: input.stableUserId,
	}).searchMessages({
		query: input.query,
		inboxId: input.inboxId,
		direction: input.direction,
		processingStatus: input.processingStatus,
		deliveryStatus: input.deliveryStatus,
		classification: input.classification,
		limit: input.limit,
	})
	return searched.messages.map((message) =>
		mailboxMessageToEmailMessageRecord(message, input.stableUserId),
	)
}

/**
 * Account inbox page: total + offset page, optional substring query and
 * classification filter. Uses Mailbox count/list/search when cutover is on.
 */
export async function listOwnerEmailMessagesPage(
	input: OwnerReadBase & {
		query: string
		classification: EmailClassification | null
		pageSize: number
		offset: number
	},
): Promise<{ total: number; messages: Array<EmailMessageRecord> }> {
	const useMailbox = await useMailboxReads(input)
	if (!useMailbox) {
		return listOwnerEmailMessagesPageFromD1(input)
	}

	const mailbox = mailboxRpc({
		env: input.env,
		userId: input.stableUserId,
	})
	const filters = {
		classification: input.classification,
		query: input.query || null,
	}
	const [{ total }, listed] = await Promise.all([
		mailbox.countMessages(filters),
		input.query
			? mailbox.searchMessages({
					query: input.query,
					classification: input.classification,
					limit: input.pageSize,
					offset: input.offset,
				})
			: mailbox.listMessages({
					classification: input.classification,
					limit: input.pageSize,
					offset: input.offset,
				}),
	])
	return {
		total,
		messages: listed.messages.map((message) =>
			mailboxMessageToEmailMessageRecord(message, input.stableUserId),
		),
	}
}

async function listOwnerEmailMessagesPageFromD1(input: {
	env: MailboxReadCutoverEnv
	stableUserId: string
	query: string
	classification: EmailClassification | null
	pageSize: number
	offset: number
}): Promise<{ total: number; messages: Array<EmailMessageRecord> }> {
	return listEmailMessagesPageForUser({
		db: input.env.APP_DB,
		userId: input.stableUserId,
		query: input.query,
		classification: input.classification,
		pageSize: input.pageSize,
		offset: input.offset,
	})
}

export async function listOwnerEmailAttachmentsForMessage(
	input: OwnerReadBase & { messageId: string },
): Promise<Array<EmailAttachmentRecord>> {
	const useMailbox = await useMailboxReads(input)
	if (!useMailbox) {
		return listEmailAttachmentsForUserMessage({
			db: input.env.APP_DB,
			userId: input.stableUserId,
			messageId: input.messageId,
		})
	}

	const attachments = await mailboxRpc({
		env: input.env,
		userId: input.stableUserId,
	}).listAttachmentsForMessage({ messageId: input.messageId })
	return attachments.map(mailboxAttachmentToEmailAttachmentRecord)
}

export async function getOwnerEmailAttachmentRecordById(
	input: OwnerReadBase & { attachmentId: string },
): Promise<EmailAttachmentRecord | null> {
	const useMailbox = await useMailboxReads(input)
	if (!useMailbox) {
		return getEmailAttachmentRecordById({
			db: input.env.APP_DB,
			userId: input.stableUserId,
			attachmentId: input.attachmentId,
		})
	}

	const attachment = await mailboxRpc({
		env: input.env,
		userId: input.stableUserId,
	}).getAttachment({ attachmentId: input.attachmentId })
	return attachment
		? mailboxAttachmentToEmailAttachmentRecord(attachment)
		: null
}

/**
 * Owner-facing attachment fetch: metadata via cutover, bytes via existing
 * EMAIL_BLOBS / raw-MIME helpers (never through the DO).
 */
export async function getOwnerEmailAttachmentById(
	input: OwnerReadBase & {
		blobs: R2Bucket
		attachmentId: string
	},
) {
	const attachment = await getOwnerEmailAttachmentRecordById(input)
	if (!attachment) return null
	const message = await getOwnerEmailMessageById({
		...input,
		messageId: attachment.messageId,
	})
	return loadEmailAttachmentContent({
		blobs: input.blobs,
		attachment,
		message,
	})
}

export async function listOwnerEmailDeliveryEvents(
	input: OwnerReadBase & {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit: number
	},
): Promise<Array<EmailDeliveryEventRecord>> {
	const useMailbox = await useMailboxReads(input)
	if (!useMailbox) {
		return listEmailDeliveryEvents({
			db: input.env.APP_DB,
			userId: input.stableUserId,
			messageId: input.messageId,
			eventType: input.eventType,
			limit: input.limit,
		})
	}

	const events = await mailboxRpc({
		env: input.env,
		userId: input.stableUserId,
	}).listDeliveryEvents({
		messageId: input.messageId,
		eventType: input.eventType,
		limit: input.limit,
	})
	return events.map((event) =>
		mailboxDeliveryEventToEmailDeliveryEventRecord(event, input.stableUserId),
	)
}

/** Load raw MIME for an owner message (metadata via cutover, bytes via R2). */
export async function loadOwnerEmailRawMime(
	input: OwnerReadBase & {
		blobs: R2Bucket
		messageId: string
	},
): Promise<string | null> {
	const message = await getOwnerEmailMessageById(input)
	if (!message) return null
	return loadRawMime({ blobs: input.blobs, message })
}

/**
 * Resolve numeric `users.id` for MCP callers that only have a stable id.
 * Returns null when missing (callers fail closed to D1 by skipping cutover).
 */
export async function resolveMailboxReadCutoverDbUserId(input: {
	db: D1Database
	stableUserId: string
}): Promise<number | null> {
	try {
		return await resolveDbUserId(input.db, input.stableUserId)
	} catch {
		return null
	}
}

export {
	mailboxAttachmentToEmailAttachmentRecord,
	mailboxMessageToEmailMessageRecord,
} from './mailbox-record-mappers.ts'
