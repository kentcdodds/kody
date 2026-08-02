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
	claimMailboxInboundDeliveryCleanup,
	markMailboxInboundDeliveryOrphanCleaned,
	releaseMailboxInboundDeliveryCleanup,
} from './mailbox-inbound-cleanup-ledger.ts'
import { bootstrapMailboxDeliveryEvents } from './mailbox-delivery-event-bootstrap.ts'
import { upsertMailboxDeliveryEvents } from './mailbox-delivery-event-upsert.ts'
import { shouldSkipMailboxDeliveryEventWrite } from './mailbox-inbound-bootstrap.ts'
import {
	claimMailboxInboundDeliveryStorage,
	claimMailboxInboundDeliveryWindow,
	deferMailboxInboundDeliveryReconciliation,
	getMailboxInboundDelivery,
	getMailboxInboundDeliveryWindow,
	insertMailboxChargedPendingInboundDelivery,
	listMailboxDueStaleInboundDeliveries,
	markMailboxInboundDeliveryReceived,
	markMailboxInboundDeliveryRejected,
	pruneMailboxExpiredInboundDedupePointers,
	releaseMailboxInboundDeliveryStorage,
	type MailboxInboundDeliveryInsertInput,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger.ts'
import {
	claimMailboxInboundSubscriptionEffect,
	claimMailboxInboundUsageEffect,
	completeMailboxInboundSubscriptionEffect,
	completeMailboxInboundUsageEffect,
	failMailboxInboundSubscriptionEffect,
	listMailboxDueInboundEffectWork,
} from './mailbox-inbound-effect-ledger.ts'
import {
	assertMailboxNonEmptyString,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
	type MailboxBootstrapDeliveryEventsResult,
	type MailboxCountMessagesInput,
	type MailboxCountResult,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageMetadataInput,
	type MailboxDeleteResult,
	type MailboxDeleteThreadIfEmptyInput,
	type MailboxDeliveryEventInput,
	type MailboxDeliveryEventRecord,
	type MailboxExportResult,
	type MailboxInboundDeliveryState,
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
 * Dual-write / read-cutover live paths are wired elsewhere. USER inbound
 * ledger/effect transitions are authoritative here; `system:email` remains D1.
 */

class MailboxBase extends DurableObject<Env> implements MailboxRpc {
	private readonly store: MailboxStore
	private retentionAlarmArmed = false
	private retentionIdleConfirmed = false

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.store = new MailboxStore(ctx.storage)
		this.ctx.blockConcurrencyWhile(async () => {
			this.store.initializeSchema()
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
			if (
				shouldSkipMailboxDeliveryEventWrite(this.ctx.storage.sql, {
					event: input.event,
				})
			) {
				return
			}
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

	async upsertDeliveryEvents(input: {
		ownerId: string
		events: Array<MailboxDeliveryEventInput>
	}): Promise<MailboxUpsertDeliveryEventsResult> {
		let result: MailboxUpsertDeliveryEventsResult | undefined
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = upsertMailboxDeliveryEvents(this.ctx.storage.sql, input.events)
		})
		if (!result) throw new Error('Mailbox upsert transaction did not run.')
		this.markRetentionDirty()
		await this.ensureRetentionAlarm()
		return result
	}

	async bootstrapDeliveryEvents(input: {
		ownerId: string
		events: Array<MailboxDeliveryEventInput>
	}): Promise<MailboxBootstrapDeliveryEventsResult> {
		let result: MailboxBootstrapDeliveryEventsResult | undefined
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = bootstrapMailboxDeliveryEvents(this.ctx.storage.sql, input)
		})
		if (!result) throw new Error('Mailbox bootstrap transaction did not run.')
		if (result.inserted > 0) {
			this.markRetentionDirty()
			await this.ensureRetentionAlarm()
		}
		return result
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

	async getInboundDelivery(input: {
		ownerId: string
		deliveryId: string
	}): Promise<MailboxInboundDeliverySnapshot | null> {
		this.store.assertOwner(input.ownerId)
		return getMailboxInboundDelivery(this.ctx.storage.sql, input.deliveryId)
	}

	async getInboundDeliveryWindow(input: {
		ownerId: string
		fingerprint: string
		now?: string
	}): Promise<MailboxInboundDeliverySnapshot | null> {
		this.store.assertOwner(input.ownerId)
		return getMailboxInboundDeliveryWindow(this.ctx.storage.sql, input)
	}

	async claimInboundDeliveryWindow(input: {
		ownerId: string
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}): Promise<MailboxInboundDeliverySnapshot> {
		let result!: MailboxInboundDeliverySnapshot
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundDeliveryWindow(this.ctx.storage.sql, input)
		})
		this.markRetentionDirty()
		await this.ensureRetentionAlarm()
		return result
	}

	async insertChargedPendingInboundDelivery(input: {
		ownerId: string
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['insertChargedPendingInboundDelivery']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = insertMailboxChargedPendingInboundDelivery(
				this.ctx.storage.sql,
				input,
			)
		})
		this.markRetentionDirty()
		await this.ensureRetentionAlarm()
		return result
	}

	async claimInboundDeliveryStorage(input: {
		ownerId: string
		deliveryId: string
		expectedAttachmentCount: number
		usageStartedAt?: string | null
		now?: string
	}) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundDeliveryStorage']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundDeliveryStorage(this.ctx.storage.sql, input)
		})
		if (result.status === 'claimed') {
			this.markRetentionDirty()
			await this.ensureRetentionAlarm()
		}
		return result
	}

	async releaseInboundDeliveryStorage(input: {
		ownerId: string
		deliveryId: string
		storageLease: string
		now?: string
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['releaseInboundDeliveryStorage']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = releaseMailboxInboundDeliveryStorage(this.ctx.storage.sql, input)
		})
		if (result.status === 'released') {
			this.markRetentionDirty()
			await this.ensureRetentionAlarm()
		}
		return result
	}

	async markInboundDeliveryRejected(input: {
		ownerId: string
		deliveryId: string
		reason: string
		expectedStorageLease?: string | null
		expectedState?: MailboxInboundDeliveryState
		now?: string
	}) {
		let result!: Awaited<ReturnType<MailboxRpc['markInboundDeliveryRejected']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = markMailboxInboundDeliveryRejected(this.ctx.storage.sql, input)
		})
		if (result.status === 'rejected') {
			this.markRetentionDirty()
			await this.ensureRetentionAlarm()
		}
		return result
	}

	async markInboundDeliveryReceived(input: {
		ownerId: string
		deliveryId: string
		storageLease: string
		usageDurationMs: number
		usageMonth: string
		usageBytes: number
		now?: string
	}) {
		let result!: Awaited<ReturnType<MailboxRpc['markInboundDeliveryReceived']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = markMailboxInboundDeliveryReceived(this.ctx.storage.sql, input)
		})
		if (result.status === 'received') {
			this.markRetentionDirty()
			await this.ensureRetentionAlarm()
		}
		return result
	}

	async pruneExpiredInboundDedupePointers(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['pruneExpiredInboundDedupePointers']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = pruneMailboxExpiredInboundDedupePointers(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.pruned > 0) {
			this.markRetentionDirty()
			await this.ensureRetentionAlarm()
		}
		return result
	}

	async deferInboundDeliveryReconciliation(input: {
		ownerId: string
		deliveryId: string
		now?: string
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['deferInboundDeliveryReconciliation']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = deferMailboxInboundDeliveryReconciliation(
				this.ctx.storage.sql,
				input,
			)
		})
		if (result.status === 'deferred') {
			this.markRetentionDirty()
			await this.ensureRetentionAlarm()
		}
		return result
	}

	async claimInboundDeliveryCleanup(input: {
		ownerId: string
		deliveryId: string
		expectedState: MailboxInboundDeliveryState
		expectedUpdatedAt: string
		staleBefore: string
		now?: string
	}) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundDeliveryCleanup']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundDeliveryCleanup(this.ctx.storage.sql, input)
		})
		return result
	}

	async releaseInboundDeliveryCleanup(input: {
		ownerId: string
		deliveryId: string
		cleanupLease: string
		now?: string
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['releaseInboundDeliveryCleanup']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = releaseMailboxInboundDeliveryCleanup(this.ctx.storage.sql, input)
		})
		return result
	}

	async markInboundDeliveryOrphanCleaned(input: {
		ownerId: string
		deliveryId: string
		cleanupLease: string
		outcome: 'deleted' | 'delete-failed'
		now?: string
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['markInboundDeliveryOrphanCleaned']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = markMailboxInboundDeliveryOrphanCleaned(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async claimInboundUsageEffect(input: {
		ownerId: string
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) {
		let result!: Awaited<ReturnType<MailboxRpc['claimInboundUsageEffect']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundUsageEffect(this.ctx.storage.sql, input)
		})
		return result
	}

	async completeInboundUsageEffect(input: {
		ownerId: string
		deliveryId: string
		usageEffectLease: string
		expectedFinalizationToken: string
		mode: 'recorded' | 'suppressed'
		usageMonth: string
		usageBytes: number
		usageDurationMs: number
		now?: string
	}) {
		let result!: Awaited<ReturnType<MailboxRpc['completeInboundUsageEffect']>>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = completeMailboxInboundUsageEffect(this.ctx.storage.sql, input)
		})
		return result
	}

	async claimInboundSubscriptionEffect(input: {
		ownerId: string
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['claimInboundSubscriptionEffect']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = claimMailboxInboundSubscriptionEffect(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async completeInboundSubscriptionEffect(input: {
		ownerId: string
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		mode: 'complete' | 'suppressed'
		suppressionReason?: string | null
		now?: string
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['completeInboundSubscriptionEffect']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = completeMailboxInboundSubscriptionEffect(
				this.ctx.storage.sql,
				input,
			)
		})
		return result
	}

	async failInboundSubscriptionEffect(input: {
		ownerId: string
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		error: string
		now?: string
	}) {
		let result!: Awaited<
			ReturnType<MailboxRpc['failInboundSubscriptionEffect']>
		>
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = failMailboxInboundSubscriptionEffect(this.ctx.storage.sql, input)
		})
		return result
	}

	async listDueStaleInboundDeliveries(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		this.store.assertOwner(input.ownerId)
		return listMailboxDueStaleInboundDeliveries(this.ctx.storage.sql, input)
	}

	async listDueInboundEffectWork(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		this.store.assertOwner(input.ownerId)
		return listMailboxDueInboundEffectWork(this.ctx.storage.sql, input)
	}

	async purge(): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAlarm().catch(() => undefined)
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
