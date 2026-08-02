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
	deleteMailboxDeliveryEvent,
	deleteMailboxMessageMetadata,
	deleteMailboxThreadIfEmpty,
	setMailboxMessageClassification,
	touchMailboxThread,
	updateMailboxMessageDelivery,
} from './mailbox-mutations.ts'
import {
	assertMailboxNonEmptyString,
	mailboxUpsertDeliveryEventsMax,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
	type MailboxCountMessagesInput,
	type MailboxCountResult,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxListMessagesInput,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxPartialMutationResult,
	type MailboxRpc,
	type MailboxRunRetentionNowResult,
	type MailboxSearchMessagesInput,
	type MailboxSetMessageClassificationInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
	type MailboxUpsertDeliveryEventBatchItemResult,
	type MailboxUpsertDeliveryEventsResult,
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

	/**
	 * Shared retention pass for `alarm` and {@link runRetentionNow}.
	 * Natural production cutoffs only; exact post-pass alarm scheduling.
	 */
	private async runRetentionPass(): Promise<MailboxRunRetentionNowResult> {
		const before = this.store.countMailbox()
		const nowMs = Date.now()
		const result = await enforceMailboxRetention({
			store: this.store,
			blobs: this.env.EMAIL_BLOBS,
		})
		const after = this.store.countMailbox()
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
		} else {
			await this.ctx.storage.setAlarm(reschedule.atMs)
			this.retentionAlarmArmed = true
			this.retentionIdleConfirmed = false
		}
		return {
			before,
			after,
			blobDeleteFailures: result.hadBlobDeleteFailures,
			expiredRemaining: result.expiredWorkRemaining,
		}
	}

	async alarm(): Promise<void> {
		await this.runRetentionPass()
	}

	/**
	 * Owner-bound retention pass (natural cutoffs only). Same scheduling as
	 * `alarm`; returns before/after counts with no row ids or content.
	 */
	async runRetentionNow(input: {
		ownerId: string
	}): Promise<MailboxRunRetentionNowResult> {
		this.store.assertOwner(input.ownerId)
		return this.runRetentionPass()
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

	/**
	 * Upsert a bounded batch of complete immutable delivery-event snapshots in
	 * one transaction / one DO RPC. Validates non-empty and
	 * {@link mailboxUpsertDeliveryEventsMax}. Does not patch message latest
	 * delivery status. Marks retention dirty once for the batch.
	 */
	async upsertDeliveryEvents(input: {
		ownerId: string
		events: Array<MailboxDeliveryEventInput>
	}): Promise<MailboxUpsertDeliveryEventsResult> {
		if (!Array.isArray(input.events) || input.events.length === 0) {
			throw new Error('Mailbox upsertDeliveryEvents events must be non-empty.')
		}
		if (input.events.length > mailboxUpsertDeliveryEventsMax) {
			throw new Error(
				`Mailbox upsertDeliveryEvents events exceed max of ${mailboxUpsertDeliveryEventsMax}.`,
			)
		}
		const results: Array<MailboxUpsertDeliveryEventBatchItemResult> = []
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			for (const event of input.events) {
				const eventId = assertMailboxNonEmptyString(event.id, 'event.id')
				const write = this.store.writeDeliveryEventRow(event)
				results.push({
					eventId,
					inserted: write.inserted,
					accepted: write.accepted,
				})
			}
		})
		this.markRetentionDirty()
		await this.ensureRetentionAlarm()
		return { results }
	}

	/**
	 * Advance thread activity without a full snapshot. Equal/newer `updatedAt`
	 * only; `last_message_at` never moves backward.
	 */
	async touchThread(
		input: MailboxTouchThreadInput,
	): Promise<MailboxPartialMutationResult> {
		let result: MailboxPartialMutationResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = touchMailboxThread(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	/**
	 * Partial delivery/processing update for dual-write parity. Equal/newer
	 * `updatedAt` only.
	 */
	async updateMessageDelivery(
		input: MailboxUpdateMessageDeliveryInput,
	): Promise<MailboxPartialMutationResult> {
		let result: MailboxPartialMutationResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = updateMailboxMessageDelivery(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	/**
	 * Partial classification update for dual-write parity. Equal/newer
	 * `updatedAt` only.
	 */
	async setMessageClassification(
		input: MailboxSetMessageClassificationInput,
	): Promise<MailboxPartialMutationResult> {
		let result: MailboxPartialMutationResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = setMailboxMessageClassification(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	/**
	 * Metadata-only delete (null delivery-event message_id + attachments +
	 * message). Never deletes R2 or empty threads.
	 */
	async deleteMessageMetadata(
		input: MailboxDeleteMessageMetadataInput,
	): Promise<MailboxDeleteResult> {
		let result: MailboxDeleteResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = deleteMailboxMessageMetadata(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	/**
	 * Metadata-only delivery-event delete. Distinguishes missing (idempotent)
	 * from stale (newer `updated_at` retained).
	 */
	async deleteDeliveryEvent(
		input: MailboxDeleteDeliveryEventInput,
	): Promise<MailboxDeleteResult> {
		let result: MailboxDeleteResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = deleteMailboxDeliveryEvent(this.ctx.storage.sql, mutationInput)
		})
		return result
	}

	/**
	 * Deferred empty-thread cleanup. Stale-safe by `thread.updated_at`.
	 */
	async deleteThreadIfEmpty(
		input: MailboxDeleteThreadIfEmptyInput,
	): Promise<MailboxDeleteResult> {
		let result: MailboxDeleteResult = { status: 'missing' }
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const { ownerId: _ownerId, ...mutationInput } = input
			result = deleteMailboxThreadIfEmpty(this.ctx.storage.sql, mutationInput)
		})
		return result
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

	async countMessages(
		input: MailboxCountMessagesInput,
	): Promise<{ total: number }> {
		return this.store.countMessages(input)
	}

	async getAttachment(input: {
		attachmentId: string
	}): Promise<MailboxAttachmentRecord | null> {
		return this.store.getAttachment(input.attachmentId)
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
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxExportRow,
	type MailboxMessageInput,
	type MailboxMessageRecord,
	type MailboxPartialMutationResult,
	type MailboxRunRetentionNowResult,
	type MailboxSetMessageClassificationInput,
	type MailboxThreadInput,
	type MailboxThreadRecord,
	type MailboxTouchThreadInput,
	type MailboxUpdateMessageDeliveryInput,
} from './mailbox-types.ts'
export {
	computeMailboxRetentionReschedule,
	selectMailboxRetentionWriteAlarm,
} from './mailbox-retention.ts'
