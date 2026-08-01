/**
 * Default-off, parity-gated Mailbox read cutover (prepared; not wired).
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
 * Exposure recording is intentionally omitted here: no live caller uses this
 * adapter yet. Future read-path wiring owns the exposure chokepoint (the
 * existing session/MCP evaluation caches once a live gate evaluates the flag,
 * or an explicit `recordFeatureFlagExposures` at the first switched call site).
 */

import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import { type MailboxMessageRecord } from './mailbox-types.ts'
import { getEmailMessageById } from './repo.ts'
import { type EmailMessageRecord } from './types.ts'

/** Continuous exact parity must hold at least this long before cutover. */
export const mailboxReadCutoverSoakMs = 24 * 60 * 60 * 1000

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

export type MailboxReadCutoverEnv = MailboxEnv & {
	APP_DB: D1Database
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

/**
 * Fail-closed cutover eligibility for one account.
 * Never throws: D1 / flag evaluation failures return false.
 */
export async function isMailboxReadCutoverEnabled(input: {
	db: D1Database
	dbUserId: number
	stableUserId: string
	now?: Date | string
}): Promise<boolean> {
	try {
		const flagEnabled = await isFeatureEnabled(
			input.db,
			mailboxReadCutoverFlagKey,
			input.dbUserId,
		)
		if (!flagEnabled) return false

		const row = await input.db
			.prepare(
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

/** Map a Mailbox DO message row back to the D1 `EmailMessageRecord` shape. */
export function mailboxMessageToEmailMessageRecord(
	message: MailboxMessageRecord,
	userId: string,
): EmailMessageRecord {
	return {
		id: message.id,
		direction: message.direction,
		userId,
		inboxId: message.inboxId,
		threadId: message.threadId,
		senderIdentityId: message.senderIdentityId,
		fromAddress: message.fromAddress,
		envelopeFrom: message.envelopeFrom,
		toAddresses: message.toAddresses,
		ccAddresses: message.ccAddresses,
		bccAddresses: message.bccAddresses,
		replyToAddresses: message.replyToAddresses,
		subject: message.subject,
		messageIdHeader: message.messageIdHeader,
		inReplyToHeader: message.inReplyToHeader,
		references: message.references,
		headers: message.headers,
		authResults: message.authResults,
		textBody: message.textBody,
		htmlBody: message.htmlBody,
		rawMimeKey: message.rawMimeKey,
		rawSize: message.rawSize,
		processingStatus: message.processingStatus,
		classification: message.classification,
		classificationReason: message.classificationReason,
		providerMessageId: message.providerMessageId,
		deliveryStatus: message.deliveryStatus,
		deliveryStatusAt: message.deliveryStatusAt,
		error: message.error,
		receivedAt: message.receivedAt,
		sentAt: message.sentAt,
		createdAt: message.createdAt,
		updatedAt: message.updatedAt,
	}
}

/**
 * Prepared owner-scoped message get. Selects D1 or Mailbox via the cutover
 * gate. Not wired into existing readers in this PR.
 */
export async function getOwnerEmailMessageById(input: {
	env: MailboxReadCutoverEnv
	dbUserId: number
	stableUserId: string
	messageId: string
	now?: Date | string
}): Promise<EmailMessageRecord | null> {
	const useMailbox = await isMailboxReadCutoverEnabled({
		db: input.env.APP_DB,
		dbUserId: input.dbUserId,
		stableUserId: input.stableUserId,
		now: input.now,
	})

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
