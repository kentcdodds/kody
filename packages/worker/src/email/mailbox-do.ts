import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
} from './types.ts'
import {
	enforceMailboxRetention,
	mailboxRetentionAlarmAtMs,
	nextMailboxRetentionDueAtMs,
} from './mailbox-retention.ts'
import { MailboxStore } from './mailbox-store.ts'
import {
	assertMailboxNonEmptyString,
	mailboxRetentionAlarmSkewMs,
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
	type MailboxSearchMessagesInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
} from './mailbox-types.ts'

/**
 * Per-owner Mailbox Durable Object: SQLite metadata for threads, messages,
 * attachments, and delivery events. Object identity is ownership — no
 * `user_id` columns. Raw MIME / external attachment bytes stay in
 * `EMAIL_BLOBS`; rows retain keys. `system:email` stays in D1 by design.
 *
 * Scaffold only: dual-write / cutover callers are not wired here.
 */

class MailboxBase extends DurableObject<Env> {
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
	 * - Overdue work uses an hourly retry delay (not now+1s) so persistent R2
	 *   failures cannot storm alarm wakes; future rows keep due-time scheduling.
	 * - `retentionAlarmArmed` skips getAlarm/setAlarm on hot writes once armed.
	 * - `retentionIdleConfirmed` skips re-evaluation only while no new row has
	 *   been written; every write clears it so the next ensure re-arms.
	 * - Never arm in the constructor.
	 */
	private async ensureRetentionAlarm() {
		if (this.retentionAlarmArmed) return
		if (this.retentionIdleConfirmed) return

		const dueAtMs = nextMailboxRetentionDueAtMs(this.store)
		const alarmAt = mailboxRetentionAlarmAtMs({ dueAtMs })
		if (alarmAt == null) {
			this.retentionIdleConfirmed = true
			this.retentionAlarmArmed = false
			return
		}

		this.retentionIdleConfirmed = false
		const existing = await this.ctx.storage.getAlarm()
		if (
			existing != null &&
			Math.abs(existing - alarmAt) < mailboxRetentionAlarmSkewMs
		) {
			this.retentionAlarmArmed = true
			return
		}
		await this.ctx.storage.setAlarm(alarmAt)
		this.retentionAlarmArmed = true
	}

	private markRetentionDirty() {
		this.retentionIdleConfirmed = false
		this.retentionAlarmArmed = false
	}

	async alarm(): Promise<void> {
		await enforceMailboxRetention({
			store: this.store,
			blobs: this.env.EMAIL_BLOBS,
		})
		const dueAtMs = nextMailboxRetentionDueAtMs(this.store)
		const alarmAt = mailboxRetentionAlarmAtMs({ dueAtMs })
		if (alarmAt == null) {
			this.retentionAlarmArmed = false
			this.retentionIdleConfirmed = true
			return
		}
		await this.ctx.storage.setAlarm(alarmAt)
		this.retentionAlarmArmed = true
		this.retentionIdleConfirmed = false
	}

	/** Atomic mirror of thread + message + attachments for dual-write. */
	async mirrorMessage(input: {
		thread?: MailboxThreadInput | null
		message: MailboxMessageInput
		attachments?: Array<MailboxAttachmentInput>
	}): Promise<{ ok: true }> {
		const message = input.message
		assertMailboxNonEmptyString(message.id, 'message.id')
		const attachments = Array.isArray(input.attachments)
			? input.attachments
			: []
		this.ctx.storage.transactionSync(() => {
			if (input.thread) {
				this.store.upsertThreadRow(input.thread)
			}
			this.store.upsertMessageRow(message)
			this.store.replaceAttachmentsForMessage(message.id, attachments)
		})
		this.markRetentionDirty()
		await this.ensureRetentionAlarm()
		return { ok: true }
	}

	/**
	 * Upsert a delivery event (idempotent on `provider_event_id`) and optionally
	 * apply a monotonic latest `delivery_status` update on the message.
	 */
	async upsertDeliveryEvent(input: {
		event: MailboxDeliveryEventInput
		latestDeliveryStatus?: {
			messageId: string
			deliveryStatus: EmailDeliveryStatus
			deliveryStatusAt: string
		} | null
	}): Promise<{ inserted: boolean; updatedLatestStatus: boolean }> {
		let inserted = false
		let updatedLatestStatus = false
		this.ctx.storage.transactionSync(() => {
			inserted = this.store.writeDeliveryEventRow(input.event)
			if (input.latestDeliveryStatus) {
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
		return { inserted, updatedLatestStatus }
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
