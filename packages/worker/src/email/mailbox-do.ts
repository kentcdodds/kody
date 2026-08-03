import * as Sentry from '@sentry/cloudflare'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import {
	type EmailDeliveryEventType,
	type EmailDeliveryStatus,
} from './types.ts'
import {
	canonicalMailboxMessageBlobReferences,
	deleteMailboxBlobKeys,
} from './mailbox-retention.ts'
import { MailboxMaintenanceCommands } from './mailbox-maintenance-commands.ts'
import { MailboxGraphCommitCommands } from './mailbox-graph-commit-commands.ts'
import { MailboxInboundCommands } from './mailbox-inbound-commands.ts'
import { MailboxStore } from './mailbox-store.ts'
import {
	deleteMailboxDeliveryEvent,
	deleteMailboxThreadIfEmpty,
	setMailboxMessageClassification,
	touchMailboxThread,
	updateMailboxMessageDelivery,
} from './mailbox-mutations.ts'
import { findDeliveryEventByProviderEventId } from './mailbox-delivery-events.ts'
import {
	deleteMailboxMessageMetadataWithTombstone,
	tombstoneMissingMailboxMessage,
} from './mailbox-message-deletion-tombstones.ts'
import { bootstrapMailboxDeliveryEvents } from './mailbox-delivery-event-bootstrap.ts'
import { upsertMailboxDeliveryEvents } from './mailbox-delivery-event-upsert.ts'
import { shouldSkipMailboxDeliveryEventWrite } from './mailbox-inbound-bootstrap.ts'
import {
	type MailboxInboundDeliveryInsertInput,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger.ts'
import {
	assertMailboxNonEmptyString,
	type MailboxAttachmentInput,
	type MailboxAttachmentRecord,
	type MailboxBlobReferencePage,
	type MailboxBootstrapDeliveryEventsResult,
	type MailboxCountMessagesInput,
	type MailboxCountResult,
	type MailboxCommitInboundMessageGraphResult,
	type MailboxCommitOutboundTerminalInput,
	type MailboxDeleteDeliveryEventInput,
	type MailboxDeleteMessageWithBlobsResult,
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
	type MailboxTombstoneMissingMessageResult,
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
 * USER graph reads/writes and inbound ledger/effect transitions are
 * authoritative here; `system:email` remains on its dedicated D1 graph.
 */

class MailboxBase extends DurableObject<Env> implements MailboxRpc {
	private readonly store: MailboxStore
	private readonly maintenance: MailboxMaintenanceCommands
	private readonly graphCommits: MailboxGraphCommitCommands
	private readonly inbound: MailboxInboundCommands

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.store = new MailboxStore(ctx.storage)
		this.maintenance = new MailboxMaintenanceCommands(ctx, env, this.store)
		this.graphCommits = new MailboxGraphCommitCommands(
			ctx,
			this.store,
			this.maintenance,
		)
		this.inbound = new MailboxInboundCommands(ctx, this.store, this.maintenance)
		this.ctx.blockConcurrencyWhile(async () => {
			this.store.initializeSchema()
			await this.maintenance.initializeAlarmState()
		})
	}

	async alarm(): Promise<void> {
		await this.maintenance.alarm()
	}

	/**
	 * Owner-bound retention pass (natural cutoffs only). Same scheduling as
	 * `alarm`; returns before/after counts with no row ids or content.
	 */
	async runRetentionNow(input: {
		ownerId: string
	}): Promise<MailboxRunRetentionNowResult> {
		return await this.maintenance.runRetentionNow(input.ownerId)
	}

	async upsertMessageGraph(input: {
		ownerId: string
		thread?: MailboxThreadInput | null
		message: MailboxMessageInput
		attachments?: Array<MailboxAttachmentInput>
	}): Promise<{ ok: true; accepted: boolean }> {
		return await this.graphCommits.upsertMessageGraph(input)
	}

	async commitInboundMessageGraph(input: {
		ownerId: string
		deliveryId: string
		storageLease: string
		thread: MailboxThreadInput
		message: MailboxMessageInput
		attachments: Array<MailboxAttachmentInput>
	}): Promise<MailboxCommitInboundMessageGraphResult> {
		return await this.graphCommits.commitInboundMessageGraph(input)
	}

	async commitOutboundTerminal(
		input: MailboxCommitOutboundTerminalInput,
	): Promise<{ message: MailboxMessageRecord; eventInserted: boolean }> {
		return await this.graphCommits.commitOutboundTerminal(input)
	}

	async completeOutboundProviderIndexRepair(input: {
		ownerId: string
		provider: string
		providerMessageId: string
	}): Promise<{ cleared: boolean }> {
		return await this.graphCommits.completeOutboundProviderIndexRepair(input)
	}

	async getOutboundProviderIndexRepairStatus(input: { ownerId: string }) {
		return this.graphCommits.getOutboundProviderIndexRepairStatus(input.ownerId)
	}

	async recordBoundedRejection(input: {
		ownerId: string
		inboxId: string
		recipient: string
		reason: string
		phase: string
		day: string
		now: string
		detailLimit: number
		detailEventId: string
	}): Promise<{ count: number; detailed: boolean }> {
		let count = 0
		let detailed = false
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			const aggregateId = `email-rejections:${input.inboxId}:${input.day}`
			const existing = this.ctx.storage.sql
				.exec<{ detail_json: string }>(
					`SELECT detail_json FROM email_delivery_events
					WHERE id = ?
					LIMIT 1`,
					aggregateId,
				)
				.toArray()[0]
			let priorCount = 0
			if (existing) {
				try {
					const detail = JSON.parse(existing.detail_json) as {
						count?: unknown
					}
					if (typeof detail.count === 'number') priorCount = detail.count
				} catch {
					priorCount = 0
				}
			}
			count = priorCount + 1
			const event = (
				id: string,
				detailJson: string,
			): MailboxDeliveryEventInput => ({
				id,
				messageId: null,
				inboxId: input.inboxId,
				eventType: 'rejected',
				provider: 'cloudflare-email-routing',
				providerMessageId: null,
				providerEventId: null,
				detailJson,
				needsEffectReconcile: false,
				state: null,
				fingerprint: null,
				storageLease: null,
				storageLeaseAt: null,
				cleanupLease: null,
				cleanupLeaseAt: null,
				cleanupRetryAt: null,
				expectedAttachmentCount: null,
				finalizationToken: null,
				reconcileAfter: null,
				dedupeExpiresAt: null,
				usageEffectRecordedAt: null,
				usageEffectSuppressedAt: null,
				usageStartedAt: null,
				usageMonth: null,
				usageBytes: null,
				usageDurationMs: null,
				usageEffectRetryAt: null,
				usageEffectLease: null,
				usageEffectLeaseAt: null,
				subscriptionEffectState: null,
				subscriptionEffectLease: null,
				subscriptionEffectLeaseAt: null,
				subscriptionEffectRetryAt: null,
				subscriptionEffectAttemptCount: null,
				subscriptionEffectDeadLetterAt: null,
				subscriptionEffectLastError: null,
				createdAt: input.now,
				updatedAt: input.now,
			})
			this.store.writeDeliveryEventRow(
				event(
					aggregateId,
					JSON.stringify({
						aggregate: true,
						day: input.day,
						count,
						last_reason: input.reason,
						last_phase: input.phase,
						last_at: input.now,
					}),
				),
			)
			if (count <= Math.max(0, Math.trunc(input.detailLimit))) {
				detailed = this.store.writeDeliveryEventRow(
					event(
						input.detailEventId,
						JSON.stringify({
							recipient: input.recipient,
							reason: input.reason,
							phase: input.phase,
						}),
					),
				).inserted
			}
		})
		await this.maintenance.markDirtyAndEnsure()
		return { count, detailed }
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
		await this.maintenance.markDirtyAndEnsure()
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
		await this.maintenance.markDirtyAndEnsure()
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
			await this.maintenance.markDirtyAndEnsure()
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
	 * Partial authoritative delivery/processing update. Equal/newer `updatedAt`
	 * only.
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
	 * Partial authoritative classification update. Equal/newer `updatedAt` only.
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
			result = deleteMailboxMessageMetadataWithTombstone(
				this.ctx.storage.sql,
				mutationInput,
			)
		})
		return result
	}

	/**
	 * Delete canonical owner-safe R2 objects before atomically deleting one
	 * message graph. Blocking input concurrency prevents an update from
	 * interleaving across the asynchronous R2 delete boundary.
	 */
	async deleteMessageWithBlobs(input: {
		ownerId: string
		messageId: string
	}): Promise<MailboxDeleteMessageWithBlobsResult> {
		return await this.maintenance.blockConcurrencySafely(async () => {
			const ownerId = this.store.assertOwner(input.ownerId)
			const messageId = assertMailboxNonEmptyString(
				input.messageId,
				'messageId',
			)
			const message = this.store.getMessage(messageId)
			if (!message) {
				return {
					status: 'missing',
					tombstoned: this.store.isMessageTombstoned(messageId),
				}
			}

			const attachments = this.store.listAttachmentsForMessage(messageId)
			const blobReferences = canonicalMailboxMessageBlobReferences({
				ownerId,
				messageId,
				direction: message.direction,
				attachments: attachments.map((attachment) => ({
					id: attachment.id,
					storage_key: attachment.storageKey,
				})),
			})
			await deleteMailboxBlobKeys(
				this.env.EMAIL_BLOBS,
				blobReferences.map((reference) => reference.key),
			)

			this.store.tombstoneAndDeleteMessage({
				messageId,
				deletedAt: new Date().toISOString(),
			})
			return {
				status: 'deleted',
				providerMessageId: message.providerMessageId,
				attachmentsSeen: attachments.length,
				externalAttachmentsSeen: attachments.filter(
					(attachment) => attachment.storageKind === 'external',
				).length,
				blobReferences,
			}
		})
	}

	async tombstoneMissingMessage(input: {
		ownerId: string
		messageId: string
		deletedAt: string
	}): Promise<MailboxTombstoneMissingMessageResult> {
		let result: MailboxTombstoneMissingMessageResult = {
			status: 'message-present',
		}
		this.ctx.storage.transactionSync(() => {
			this.store.assertOwner(input.ownerId)
			result = tombstoneMissingMailboxMessage(this.ctx.storage.sql, input)
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

	async findThreadForInboundMessage(input: {
		inboxId?: string | null
		references: Array<string>
		inReplyToHeader?: string | null
	}): Promise<MailboxThreadRecord | null> {
		return this.store.findThreadForInboundMessage(input)
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

	async countDeliveryEvents(input: {
		ownerId: string
		eventType: EmailDeliveryEventType
		provider: string
		createdAtGte: string
	}): Promise<{ count: number }> {
		this.store.assertOwner(input.ownerId)
		const row = this.ctx.storage.sql
			.exec<{ count: number }>(
				`SELECT COUNT(*) AS count
				FROM email_delivery_events
				WHERE event_type = ?
					AND provider = ?
					AND created_at >= ?`,
				input.eventType,
				input.provider,
				input.createdAtGte,
			)
			.one()
		return { count: Number(row.count) }
	}

	async getDeliveryEventByProviderEventId(input: {
		providerEventId: string
	}): Promise<MailboxDeliveryEventRecord | null> {
		return findDeliveryEventByProviderEventId(
			this.ctx.storage.sql,
			input.providerEventId,
		)
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
		return this.inbound.getInboundDelivery(input)
	}

	async getInboundDeliveryWindow(input: {
		ownerId: string
		fingerprint: string
		now?: string
	}): Promise<MailboxInboundDeliverySnapshot | null> {
		return this.inbound.getInboundDeliveryWindow(input)
	}

	async claimInboundDeliveryWindow(input: {
		ownerId: string
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}): Promise<MailboxInboundDeliverySnapshot> {
		return await this.inbound.claimInboundDeliveryWindow(input)
	}

	async insertChargedPendingInboundDelivery(input: {
		ownerId: string
		delivery: MailboxInboundDeliveryInsertInput
		now?: string
	}) {
		return await this.inbound.insertChargedPendingInboundDelivery(input)
	}

	async claimInboundDeliveryStorage(input: {
		ownerId: string
		deliveryId: string
		expectedAttachmentCount: number
		usageStartedAt?: string | null
		now?: string
	}) {
		return await this.inbound.claimInboundDeliveryStorage(input)
	}

	async releaseInboundDeliveryStorage(input: {
		ownerId: string
		deliveryId: string
		storageLease: string
		now?: string
	}) {
		return await this.inbound.releaseInboundDeliveryStorage(input)
	}

	async markInboundDeliveryRejected(input: {
		ownerId: string
		deliveryId: string
		reason: string
		expectedStorageLease?: string | null
		expectedState?: MailboxInboundDeliveryState
		now?: string
	}) {
		return await this.inbound.markInboundDeliveryRejected(input)
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
		return await this.inbound.markInboundDeliveryReceived(input)
	}

	async pruneExpiredInboundDedupePointers(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		return await this.inbound.pruneExpiredInboundDedupePointers(input)
	}

	async deferInboundDeliveryReconciliation(input: {
		ownerId: string
		deliveryId: string
		now?: string
	}) {
		return await this.inbound.deferInboundDeliveryReconciliation(input)
	}

	async claimInboundDeliveryCleanup(input: {
		ownerId: string
		deliveryId: string
		expectedState: MailboxInboundDeliveryState
		expectedUpdatedAt: string
		staleBefore: string
		now?: string
	}) {
		return this.inbound.claimInboundDeliveryCleanup(input)
	}

	async releaseInboundDeliveryCleanup(input: {
		ownerId: string
		deliveryId: string
		cleanupLease: string
		now?: string
	}) {
		return this.inbound.releaseInboundDeliveryCleanup(input)
	}

	async markInboundDeliveryOrphanCleaned(input: {
		ownerId: string
		deliveryId: string
		cleanupLease: string
		outcome: 'deleted' | 'delete-failed'
		now?: string
	}) {
		return this.inbound.markInboundDeliveryOrphanCleaned(input)
	}

	async claimInboundUsageEffect(input: {
		ownerId: string
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) {
		return this.inbound.claimInboundUsageEffect(input)
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
		return this.inbound.completeInboundUsageEffect(input)
	}

	async claimInboundSubscriptionEffect(input: {
		ownerId: string
		deliveryId: string
		expectedFinalizationToken?: string | null
		now?: string
	}) {
		return this.inbound.claimInboundSubscriptionEffect(input)
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
		return this.inbound.completeInboundSubscriptionEffect(input)
	}

	async failInboundSubscriptionEffect(input: {
		ownerId: string
		deliveryId: string
		subscriptionEffectLease: string
		expectedFinalizationToken: string
		error: string
		now?: string
	}) {
		return this.inbound.failInboundSubscriptionEffect(input)
	}

	async listDueStaleInboundDeliveries(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		return this.inbound.listDueStaleInboundDeliveries(input)
	}

	async listDueInboundEffectWork(input: {
		ownerId: string
		now?: string
		limit?: number
	}) {
		return this.inbound.listDueInboundEffectWork(input)
	}

	async getInboundDueWorkHint(input: {
		ownerId: string
	}): Promise<{ dueAt: string | null }> {
		return this.inbound.getInboundDueWorkHint(input)
	}

	async purge(): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAlarm().catch(() => undefined)
			await this.ctx.storage.deleteAll()
			this.maintenance.resetAfterPurge()
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
