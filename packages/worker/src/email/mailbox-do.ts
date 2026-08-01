import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
} from './types.ts'
import {
	computeMailboxRetentionReschedule,
	enforceMailboxRetention,
	mailboxRetentionAlarmAtMs,
	nextMailboxRetentionDueAtMs,
	selectMailboxRetentionWriteAlarm,
} from './mailbox-retention.ts'
import { MailboxStore } from './mailbox-store.ts'
import {
	assertMailboxNonEmptyString,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
	type MailboxCountResult,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxListMessagesInput,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxRpc,
	type MailboxSearchMessagesInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
} from './mailbox-types.ts'

/**
 * Per-owner Mailbox Durable Object: SQLite metadata for threads, messages,
 * attachments, and delivery events. Object identity is ownership — no
 * `user_id` columns on data rows. Owner binding for blob-key validation is
 * a singleton identity row (DO name is not introspectable). Raw MIME /
 * external attachment bytes stay in `EMAIL_BLOBS`; rows retain keys.
 * `system:email` stays in D1 by design.
 *
 * Scaffold only: dual-write / cutover callers are not wired here.
 */

class MailboxBase extends DurableObject<Env> implements MailboxRpc {
	private readonly store: MailboxStore
	/**
	 * In-isolate cache: once an alarm is scheduled, hot writes skip
	 * getAlarm/setAlarm. Cleared when retention becomes idle or a write may
	 * need an earlier wake.
	 */
	private retentionAlarmArmed = false
	/**
	 * In-isolate: no future retention work. Cleared on every data write so
	 * ensureRetentionAlarm re-arms for the new row's due-time.
	 */
	private retentionIdleConfirmed = false

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.store = new MailboxStore(ctx.storage)
		this.ctx.blockConcurrencyWhile(async () => {
			this.store.initializeSchema()
			// Observe existing alarm only — never arm in the constructor.
			this.retentionAlarmArmed = (await this.ctx.storage.getAlarm()) != null
		})
	}

	/**
	 * Arming rule (keep this comment accurate — reviewers rely on it):
	 *
	 * - Schedule at most one alarm for the soonest retention due-time.
	 * - Overdue work on the write path uses an hourly retry delay (not now+1s).
	 * - Write-path ensure never postpones an earlier existing alarm (skew-equal
	 *   times keep the existing alarm to avoid churn).
	 * - After an alarm: blob failures → hourly backoff; successful pass with
	 *   expired rows remaining → near-immediate continuation; else future due.
	 * - `retentionAlarmArmed` skips getAlarm/setAlarm on hot writes once armed.
	 * - `retentionIdleConfirmed` skips re-evaluation only while no new row has
	 *   been written; every write clears it so the next ensure re-arms.
	 * - Never arm in the constructor.
	 */
	private async ensureRetentionAlarm() {
		if (this.retentionAlarmArmed) return
		if (this.retentionIdleConfirmed) return

		const dueAtMs = nextMailboxRetentionDueAtMs(this.store)
		const proposedAtMs = mailboxRetentionAlarmAtMs({ dueAtMs })
		const existingAtMs = await this.ctx.storage.getAlarm()
		const selection = selectMailboxRetentionWriteAlarm({
			proposedAtMs,
			existingAtMs,
		})
		switch (selection.action) {
			case 'idle':
				this.retentionIdleConfirmed = true
				this.retentionAlarmArmed = false
				return
			case 'keep-existing':
				this.retentionIdleConfirmed = false
				this.retentionAlarmArmed = true
				return
			case 'set':
				this.retentionIdleConfirmed = false
				await this.ctx.storage.setAlarm(selection.atMs)
				this.retentionAlarmArmed = true
				return
			default: {
				const exhaustive: never = selection
				throw new Error(
					`Unhandled retention write-alarm selection: ${String(exhaustive)}`,
				)
			}
		}
	}

	private markRetentionDirty() {
		this.retentionIdleConfirmed = false
		this.retentionAlarmArmed = false
	}

	async alarm(): Promise<void> {
		const nowMs = Date.now()
		const result = await enforceMailboxRetention({
			store: this.store,
			blobs: this.env.EMAIL_BLOBS,
		})
		const nextDueAtMs = nextMailboxRetentionDueAtMs(this.store)
		const reschedule = computeMailboxRetentionReschedule({
			nowMs,
			hadBlobDeleteFailures: result.hadBlobDeleteFailures,
			expiredWorkRemaining: result.expiredWorkRemaining,
			nextDueAtMs,
		})
		if (reschedule.atMs == null) {
			this.retentionAlarmArmed = false
			this.retentionIdleConfirmed = true
			return
		}
		await this.ctx.storage.setAlarm(reschedule.atMs)
		this.retentionAlarmArmed = true
		this.retentionIdleConfirmed = false
	}

	/** Atomic mirror of thread + message + attachments for dual-write. */
	async mirrorMessage(input: {
		ownerId: string
		thread?: MailboxThreadInput | null
		message: MailboxMessageInput
		attachments?: Array<MailboxAttachmentInput>
	}): Promise<{ ok: true; accepted: boolean }> {
		const message = input.message
		assertMailboxNonEmptyString(message.id, 'message.id')
		let accepted = false
		this.ctx.storage.transactionSync(() => {
			const ownerId = this.store.assertOwner(input.ownerId)
			this.store.validateMessageBlobKeys({
				ownerId,
				message,
				attachments: input.attachments,
			})
			if (input.thread) {
				this.store.upsertThreadRow(input.thread)
			}
			const messageResult = this.store.upsertMessageRow(message)
			accepted = messageResult.accepted
			if (accepted && input.attachments !== undefined) {
				this.store.replaceAttachmentsForMessage(message.id, input.attachments)
			}
		})
		this.markRetentionDirty()
		await this.ensureRetentionAlarm()
		return { ok: true, accepted }
	}

	/**
	 * Upsert a delivery event (idempotent on `provider_event_id`) and optionally
	 * apply a monotonic latest `delivery_status` update on the message.
	 */
	async upsertDeliveryEvent(input: {
		ownerId: string
		event: MailboxDeliveryEventInput
		latestDeliveryStatus?: {
			messageId: string
			deliveryStatus: EmailDeliveryStatus
			deliveryStatusAt: string
		} | null
	}): Promise<{
		inserted: boolean
		accepted: boolean
		updatedLatestStatus: boolean
	}> {
		let inserted = false
		let accepted = false
		let updatedLatestStatus = false
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const write = this.store.writeDeliveryEventRow(input.event)
			inserted = write.inserted
			accepted = write.accepted
			if (accepted && input.latestDeliveryStatus) {
				const eventId = assertMailboxNonEmptyString(input.event.id, 'event.id')
				const messageId = assertMailboxNonEmptyString(
					input.latestDeliveryStatus.messageId,
					'latestDeliveryStatus.messageId',
				)
				if (this.store.deliveryEventOwnsMessage(eventId, messageId)) {
					updatedLatestStatus = this.store.updateLatestDeliveryStatus(
						input.latestDeliveryStatus,
					)
				}
			}
		})
		this.markRetentionDirty()
		await this.ensureRetentionAlarm()
		return { inserted, accepted, updatedLatestStatus }
	}

	async getThread(input: {
		threadId: string
	}): Promise<MailboxThreadRecord | null> {
		return this.store.getThread(input.threadId)
	}

	async getMessage(input: {
		messageId: string
	}): Promise<MailboxMessageRecord | null> {
		return this.store.getMessage(input.messageId)
	}

	async getMessageByMessageIdHeader(input: {
		messageIdHeader: string
	}): Promise<MailboxMessageRecord | null> {
		return this.store.getMessageByMessageIdHeader(input.messageIdHeader)
	}

	async getOutboundMessageByProviderMessageId(input: {
		providerMessageId: string
	}): Promise<MailboxMessageRecord | null> {
		return this.store.getOutboundMessageByProviderMessageId(
			input.providerMessageId,
		)
	}

	async listMessages(input: MailboxListMessagesInput): Promise<{
		messages: Array<MailboxMessageRecord>
		nextCursor: string | null
	}> {
		return this.store.listMessages(input)
	}

	async searchMessages(input: MailboxSearchMessagesInput): Promise<{
		messages: Array<MailboxMessageRecord>
	}> {
		return this.store.searchMessages(input)
	}

	async listAttachmentsForMessage(input: {
		messageId: string
	}): Promise<Array<MailboxAttachmentRecord>> {
		return this.store.listAttachmentsForMessage(input.messageId)
	}

	async listDeliveryEvents(input: {
		messageId?: string | null
		eventType?: EmailDeliveryEventType | null
		limit?: number
	}): Promise<Array<MailboxDeliveryEventRecord>> {
		return this.store.listDeliveryEvents(input)
	}

	async countMailbox(): Promise<MailboxCountResult> {
		return this.store.countMailbox()
	}

	async exportMailbox(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<MailboxExportResult> {
		return this.store.exportMailbox(input)
	}

	async listBlobReferences(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<MailboxBlobReferencePage> {
		return this.store.listBlobReferences(input)
	}

	/**
	 * Clear SQLite state only. During expand, D1 deletion remains authoritative
	 * for R2 objects.
	 */
	async purge(): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAlarm().catch(() => {
				// Best effort: deleteAll below still clears persisted alarm state.
			})
			await this.ctx.storage.deleteAll()
			this.retentionAlarmArmed = false
			this.retentionIdleConfirmed = true
			this.store.initializeSchema()
		})
		return { ok: true }
	}
}

export const Mailbox = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	MailboxBase,
)

export type { MailboxRpc } from './mailbox-types.ts'
export {
	mailboxDeliveryEventRetentionDays,
	mailboxMessageRetentionDays,
	mailboxRetentionContinuationDelayMs,
	mailboxRetentionRetryDelayMs,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReference,
	type MailboxBlobReferencePage,
	type MailboxCountResult,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxExportRow,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxThreadInput,
	type MailboxThreadRecord,
} from './mailbox-types.ts'
export {
	computeMailboxRetentionReschedule,
	selectMailboxRetentionWriteAlarm,
} from './mailbox-retention.ts'
