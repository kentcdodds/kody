import {
	buildEntitlementUpgradeHint,
	EntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { type PlanName } from '#worker/entitlements/plans.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import {
	getInboundDelivery as getD1InboundDelivery,
	getInboundDeliveryWindow as getD1InboundDeliveryWindow,
	InboundDeliveryLeaseLostError,
	type InboundDelivery,
} from './inbound-delivery.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	detailJsonFromMailboxInboundSnapshot,
	mailboxInboundDedupePointerId,
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
	needsMailboxEffectReconcile,
	type MailboxInboundDeliveryInsertInput,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger.ts'
import {
	type MailboxDeliveryEventInput,
	type MailboxInboundDeliveryState,
} from './mailbox-types.ts'
import { systemEmailOwnerId } from './email-owner.ts'

export type UserInboundDeliveryAuthorityEnv = {
	APP_DB: D1Database
} & MailboxEnv &
	UserMeterEnv

function toInsertInput(
	delivery: InboundDelivery,
): MailboxInboundDeliveryInsertInput {
	return {
		fingerprint: delivery.fingerprint,
		deliveryId: delivery.deliveryId,
		messageId: delivery.messageId,
		threadId: delivery.threadId,
		rawMimeKey: delivery.rawMimeKey,
		inboxId: delivery.inboxId,
		recipient: delivery.recipient,
		envelopeFrom: delivery.envelopeFrom,
		provider: delivery.provider,
		quotaDay: delivery.quotaDay,
		dedupeExpiresAt: delivery.dedupeExpiresAt,
		usageStartedAt: delivery.usageStartedAt,
	}
}

function toInboundDelivery(
	userId: string,
	snapshot: MailboxInboundDeliverySnapshot,
): InboundDelivery {
	const {
		createdAt: _createdAt,
		updatedAt: _updatedAt,
		cleanupRetryAt: _cleanupRetryAt,
		reconcileAfter: _reconcileAfter,
		...delivery
	} = snapshot
	return { ...delivery, userId }
}

function eventTypeForState(state: MailboxInboundDeliveryState) {
	switch (state) {
		case 'received':
			return 'received' as const
		case 'rejected':
			return 'rejected' as const
		case 'pending':
		case 'storing':
		case 'cleaning':
		case 'orphan-cleaned':
			return 'receive_started' as const
		default: {
			const exhaustive: never = state
			throw new Error(`Unhandled inbound delivery state: ${String(exhaustive)}`)
		}
	}
}

function toMailboxBootstrapEvent(input: {
	delivery: InboundDelivery
	eventId: string
	provider: string
	createdAt: string
	updatedAt: string
}): MailboxDeliveryEventInput {
	const delivery = input.delivery
	const detail = JSON.stringify(delivery)
	return {
		id: input.eventId,
		messageId: delivery.state === 'received' ? delivery.messageId : null,
		inboxId: delivery.inboxId,
		eventType: eventTypeForState(delivery.state),
		provider: input.provider,
		providerMessageId: null,
		providerEventId: input.eventId,
		detailJson: detail,
		needsEffectReconcile:
			delivery.state === 'received' && needsMailboxEffectReconcile(delivery),
		state: delivery.state,
		fingerprint: delivery.fingerprint,
		storageLease: delivery.storageLease ?? null,
		storageLeaseAt: delivery.storageLeaseAt ?? null,
		cleanupLease: delivery.cleanupLease ?? null,
		cleanupLeaseAt: delivery.cleanupLeaseAt ?? null,
		cleanupRetryAt: null,
		expectedAttachmentCount: delivery.expectedAttachmentCount ?? null,
		finalizationToken: delivery.finalizationToken ?? null,
		reconcileAfter: null,
		dedupeExpiresAt: delivery.dedupeExpiresAt,
		usageEffectRecordedAt: delivery.usageEffectRecordedAt ?? null,
		usageEffectSuppressedAt: delivery.usageEffectSuppressedAt ?? null,
		usageStartedAt: delivery.usageStartedAt ?? null,
		usageMonth: delivery.usageMonth ?? null,
		usageBytes: delivery.usageBytes ?? null,
		usageDurationMs: delivery.usageDurationMs ?? null,
		usageEffectRetryAt: delivery.usageEffectRetryAt ?? null,
		usageEffectLease: delivery.usageEffectLease ?? null,
		usageEffectLeaseAt: delivery.usageEffectLeaseAt ?? null,
		subscriptionEffectState: delivery.subscriptionEffectState ?? null,
		subscriptionEffectLease: delivery.subscriptionEffectLease ?? null,
		subscriptionEffectLeaseAt: delivery.subscriptionEffectLeaseAt ?? null,
		subscriptionEffectRetryAt: delivery.subscriptionEffectRetryAt ?? null,
		subscriptionEffectAttemptCount:
			delivery.subscriptionEffectAttemptCount ?? null,
		subscriptionEffectDeadLetterAt:
			delivery.subscriptionEffectDeadLetterAt ?? null,
		subscriptionEffectLastError: delivery.subscriptionEffectLastError ?? null,
		createdAt: input.createdAt,
		updatedAt: input.updatedAt,
	}
}

async function d1EventTimestamps(input: {
	db: D1Database
	userId: string
	eventId: string
	provider: string
}) {
	return await input.db
		.prepare(
			`SELECT created_at, COALESCE(updated_at, created_at) AS updated_at
			FROM email_delivery_events
			WHERE id = ? AND user_id = ? AND provider = ?
			LIMIT 1`,
		)
		.bind(input.eventId, input.userId, input.provider)
		.first<{ created_at: string; updated_at: string }>()
}

/**
 * Full Mailbox → D1 compatibility snapshot. The conflict fence prevents a
 * different owner/provider from being overwritten, while updated_at rejects
 * delayed mirrors from an older Mailbox CAS.
 */
export async function mirrorUserInboundDeliverySnapshotToD1(input: {
	db: D1Database
	userId: string
	snapshot: MailboxInboundDeliverySnapshot
	eventId?: string
	provider?: string
}) {
	const snapshot = input.snapshot
	const eventId = input.eventId ?? snapshot.deliveryId
	const provider = input.provider ?? mailboxInboundProvider
	const eventType = eventTypeForState(snapshot.state)
	const detailJson = detailJsonFromMailboxInboundSnapshot(snapshot, {
		userId: input.userId,
	})
	const result = await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, inbox_id, event_type, provider,
				provider_message_id, provider_event_id, detail_json,
				needs_effect_reconcile, state, fingerprint,
				storage_lease, storage_lease_at, cleanup_lease, cleanup_lease_at,
				cleanup_retry_at, expected_attachment_count, finalization_token,
				reconcile_after, dedupe_expires_at, usage_effect_recorded_at,
				usage_effect_suppressed_at, usage_started_at, usage_month,
				usage_bytes, usage_duration_ms, usage_effect_retry_at,
				usage_effect_lease, usage_effect_lease_at, subscription_effect_state,
				subscription_effect_lease, subscription_effect_lease_at,
				subscription_effect_retry_at, subscription_effect_attempt_count,
				subscription_effect_dead_letter_at, subscription_effect_last_error,
				created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
			ON CONFLICT(id) DO UPDATE SET
				message_id = excluded.message_id,
				inbox_id = excluded.inbox_id,
				event_type = excluded.event_type,
				provider_event_id = excluded.provider_event_id,
				detail_json = excluded.detail_json,
				needs_effect_reconcile = excluded.needs_effect_reconcile,
				state = excluded.state,
				fingerprint = excluded.fingerprint,
				storage_lease = excluded.storage_lease,
				storage_lease_at = excluded.storage_lease_at,
				cleanup_lease = excluded.cleanup_lease,
				cleanup_lease_at = excluded.cleanup_lease_at,
				cleanup_retry_at = excluded.cleanup_retry_at,
				expected_attachment_count = excluded.expected_attachment_count,
				finalization_token = excluded.finalization_token,
				reconcile_after = excluded.reconcile_after,
				dedupe_expires_at = excluded.dedupe_expires_at,
				usage_effect_recorded_at = excluded.usage_effect_recorded_at,
				usage_effect_suppressed_at = excluded.usage_effect_suppressed_at,
				usage_started_at = excluded.usage_started_at,
				usage_month = excluded.usage_month,
				usage_bytes = excluded.usage_bytes,
				usage_duration_ms = excluded.usage_duration_ms,
				usage_effect_retry_at = excluded.usage_effect_retry_at,
				usage_effect_lease = excluded.usage_effect_lease,
				usage_effect_lease_at = excluded.usage_effect_lease_at,
				subscription_effect_state = excluded.subscription_effect_state,
				subscription_effect_lease = excluded.subscription_effect_lease,
				subscription_effect_lease_at = excluded.subscription_effect_lease_at,
				subscription_effect_retry_at = excluded.subscription_effect_retry_at,
				subscription_effect_attempt_count = excluded.subscription_effect_attempt_count,
				subscription_effect_dead_letter_at = excluded.subscription_effect_dead_letter_at,
				subscription_effect_last_error = excluded.subscription_effect_last_error,
				updated_at = excluded.updated_at
			WHERE email_delivery_events.user_id = excluded.user_id
				AND email_delivery_events.provider = excluded.provider
				AND excluded.updated_at >= COALESCE(
					email_delivery_events.updated_at,
					email_delivery_events.created_at
				)`,
		)
		.bind(
			eventId,
			snapshot.state === 'received' ? snapshot.messageId : null,
			input.userId,
			snapshot.inboxId,
			eventType,
			provider,
			eventId,
			detailJson,
			snapshot.state === 'received' && needsMailboxEffectReconcile(snapshot)
				? 1
				: 0,
			snapshot.state,
			snapshot.fingerprint,
			snapshot.storageLease ?? null,
			snapshot.storageLeaseAt ?? null,
			snapshot.cleanupLease ?? null,
			snapshot.cleanupLeaseAt ?? null,
			snapshot.cleanupRetryAt ?? null,
			snapshot.expectedAttachmentCount ?? null,
			snapshot.finalizationToken ?? null,
			snapshot.reconcileAfter ?? null,
			snapshot.dedupeExpiresAt,
			snapshot.usageEffectRecordedAt ?? null,
			snapshot.usageEffectSuppressedAt ?? null,
			snapshot.usageStartedAt ?? null,
			snapshot.usageMonth ?? null,
			snapshot.usageBytes ?? null,
			snapshot.usageDurationMs ?? null,
			snapshot.usageEffectRetryAt ?? null,
			snapshot.usageEffectLease ?? null,
			snapshot.usageEffectLeaseAt ?? null,
			snapshot.subscriptionEffectState ?? null,
			snapshot.subscriptionEffectLease ?? null,
			snapshot.subscriptionEffectLeaseAt ?? null,
			snapshot.subscriptionEffectRetryAt ?? null,
			snapshot.subscriptionEffectAttemptCount ?? null,
			snapshot.subscriptionEffectDeadLetterAt ?? null,
			snapshot.subscriptionEffectLastError ?? null,
			snapshot.createdAt,
			snapshot.updatedAt,
		)
		.run()
	if (Number(result.meta.changes ?? 0) < 1) {
		throw new Error(
			'Mailbox inbound snapshot failed its D1 owner/provider fence.',
		)
	}
}

async function bootstrapDeliveryFromD1(input: {
	env: UserInboundDeliveryAuthorityEnv
	userId: string
	deliveryId: string
}) {
	const delivery = await getD1InboundDelivery({
		db: input.env.APP_DB,
		userId: input.userId,
		deliveryId: input.deliveryId,
	})
	if (!delivery) return null
	const timestamps = await d1EventTimestamps({
		db: input.env.APP_DB,
		userId: input.userId,
		eventId: input.deliveryId,
		provider: mailboxInboundProvider,
	})
	if (!timestamps) return null
	const mailbox = mailboxRpc({ env: input.env, userId: input.userId })
	await mailbox.upsertDeliveryEvent({
		ownerId: input.userId,
		event: toMailboxBootstrapEvent({
			delivery,
			eventId: input.deliveryId,
			provider: mailboxInboundProvider,
			createdAt: timestamps.created_at,
			updatedAt: timestamps.updated_at,
		}),
	})
	return await mailbox.getInboundDelivery({
		ownerId: input.userId,
		deliveryId: input.deliveryId,
	})
}

async function bootstrapWindowFromD1(input: {
	env: UserInboundDeliveryAuthorityEnv
	userId: string
	fingerprint: string
	now: Date
}) {
	const delivery = await getD1InboundDeliveryWindow({
		db: input.env.APP_DB,
		userId: input.userId,
		fingerprint: input.fingerprint,
		now: input.now,
	})
	if (!delivery) return null
	const eventId = mailboxInboundDedupePointerId(input.fingerprint)
	const timestamps = await d1EventTimestamps({
		db: input.env.APP_DB,
		userId: input.userId,
		eventId,
		provider: mailboxInboundDedupeProvider,
	})
	if (!timestamps) return null
	const mailbox = mailboxRpc({ env: input.env, userId: input.userId })
	await mailbox.upsertDeliveryEvent({
		ownerId: input.userId,
		event: toMailboxBootstrapEvent({
			delivery,
			eventId,
			provider: mailboxInboundDedupeProvider,
			createdAt: timestamps.created_at,
			updatedAt: timestamps.updated_at,
		}),
	})
	return await mailbox.getInboundDeliveryWindow({
		ownerId: input.userId,
		fingerprint: input.fingerprint,
		now: input.now.toISOString(),
	})
}

export function createUserInboundDeliveryAuthority(input: {
	env: UserInboundDeliveryAuthorityEnv
	userId: string
}) {
	const { env, userId } = input
	if (userId === systemEmailOwnerId) {
		throw new Error(
			'system:email inbound delivery authority must remain in D1.',
		)
	}
	const mailbox = mailboxRpc({ env, userId })
	const mirror = async (
		snapshot: MailboxInboundDeliverySnapshot,
		options?: { eventId?: string; provider?: string },
	) => {
		await mirrorUserInboundDeliverySnapshotToD1({
			db: env.APP_DB,
			userId,
			snapshot,
			...options,
		})
		return toInboundDelivery(userId, snapshot)
	}
	return {
		async get(deliveryId: string) {
			const current =
				(await mailbox.getInboundDelivery({ ownerId: userId, deliveryId })) ??
				(await bootstrapDeliveryFromD1({ env, userId, deliveryId }))
			return current ? await mirror(current) : null
		},
		async getWindow(fingerprint: string, now: Date) {
			const current =
				(await mailbox.getInboundDeliveryWindow({
					ownerId: userId,
					fingerprint,
					now: now.toISOString(),
				})) ?? (await bootstrapWindowFromD1({ env, userId, fingerprint, now }))
			return current
				? await mirror(current, {
						eventId: mailboxInboundDedupePointerId(fingerprint),
						provider: mailboxInboundDedupeProvider,
					})
				: null
		},
		async claimWindow(delivery: InboundDelivery, now: Date) {
			const snapshot = await mailbox.claimInboundDeliveryWindow({
				ownerId: userId,
				delivery: toInsertInput(delivery),
				now: now.toISOString(),
			})
			return await mirror(snapshot, {
				eventId: mailboxInboundDedupePointerId(delivery.fingerprint),
				provider: mailboxInboundDedupeProvider,
			})
		},
		async charge(input: {
			delivery: InboundDelivery
			plan: PlanName
			limit: number
			now: Date
		}) {
			const existing = await this.get(input.delivery.deliveryId)
			if (existing) return existing
			const updatedAt = input.now.toISOString()
			const meter = userMeterRpc({ env, userId })
			let meterResult = await meter.consumeInboundDelivery({
				deliveryId: input.delivery.deliveryId,
				resource: 'email_receives_per_day',
				day: input.delivery.quotaDay,
				limit: input.limit,
				updatedAt,
			})
			if (meterResult.outcome === 'needs_bootstrap') {
				await meter.initialize({
					resource: 'email_receives_per_day',
					day: input.delivery.quotaDay,
					count: 0,
					updatedAt,
				})
				meterResult = await meter.consumeInboundDelivery({
					deliveryId: input.delivery.deliveryId,
					resource: 'email_receives_per_day',
					day: input.delivery.quotaDay,
					limit: input.limit,
					updatedAt,
				})
				if (meterResult.outcome === 'needs_bootstrap') {
					throw new Error(
						'UserMeter inbound delivery consume still needs bootstrap after initialize.',
					)
				}
			}
			if (!meterResult.consumed && !meterResult.replayed) {
				throw new EntitlementLimitError({
					resource: 'email_receives_per_day',
					plan: input.plan,
					limit: input.limit,
					current: meterResult.count,
					upgradeHint: buildEntitlementUpgradeHint('email_receives_per_day'),
				})
			}
			// UserMeter is deliberately the first durable mutation. Only after
			// its idempotent claim succeeds may Mailbox claim the dedupe window
			// and insert the charged delivery.
			const claimedDelivery = await this.claimWindow(input.delivery, input.now)
			const result = await mailbox.insertChargedPendingInboundDelivery({
				ownerId: userId,
				delivery: toInsertInput(claimedDelivery),
				now: updatedAt,
			})
			await mirror(result.delivery)
			return result.status === 'inserted' &&
				claimedDelivery.deliveryId === input.delivery.deliveryId
				? input.delivery
				: toInboundDelivery(userId, result.delivery)
		},
		async claimStorage(
			delivery: InboundDelivery,
			expectedAttachmentCount: number,
			usageStartedAt?: string,
			now = new Date(),
		) {
			const result = await mailbox.claimInboundDeliveryStorage({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				expectedAttachmentCount,
				usageStartedAt,
				now: now.toISOString(),
			})
			if (result.status === 'claimed') {
				return {
					claimed: true as const,
					delivery: await mirror(result.delivery),
				}
			}
			return {
				claimed: false as const,
				delivery: result.delivery ? await mirror(result.delivery) : null,
			}
		},
		async releaseStorage(delivery: InboundDelivery, now = new Date()) {
			if (!delivery.storageLease) return
			const result = await mailbox.releaseInboundDeliveryStorage({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				storageLease: delivery.storageLease,
				now: now.toISOString(),
			})
			if (result.status === 'released') await mirror(result.delivery)
		},
		async reject(delivery: InboundDelivery, reason: string, now = new Date()) {
			const result = await mailbox.markInboundDeliveryRejected({
				ownerId: userId,
				deliveryId: delivery.deliveryId,
				reason,
				expectedStorageLease: delivery.storageLease,
				expectedState: delivery.state,
				now: now.toISOString(),
			})
			if (
				result.status === 'rejected' ||
				result.status === 'already-rejected'
			) {
				await mirror(result.delivery)
				return true
			}
			if (result.status === 'already-received') {
				await mirror(result.delivery)
				return false
			}
			throw new InboundDeliveryLeaseLostError(
				'Inbound rejection lost a state race; delivery should be retried.',
			)
		},
		async receive(input: {
			delivery: InboundDelivery
			usageDurationMs: number
			usageMonth: string
			usageBytes: number
			now?: Date
		}) {
			if (!input.delivery.storageLease) {
				throw new InboundDeliveryLeaseLostError(
					'Inbound delivery finalization requires a storage lease.',
				)
			}
			const result = await mailbox.markInboundDeliveryReceived({
				ownerId: userId,
				deliveryId: input.delivery.deliveryId,
				storageLease: input.delivery.storageLease,
				usageDurationMs: input.usageDurationMs,
				usageMonth: input.usageMonth,
				usageBytes: input.usageBytes,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (
				result.status === 'received' ||
				result.status === 'already-received'
			) {
				return await mirror(result.delivery)
			}
			throw new InboundDeliveryLeaseLostError(
				'Inbound delivery storage lease was lost before finalization.',
			)
		},
		async deferReconciliation(deliveryId: string, now = new Date()) {
			const result = await mailbox.deferInboundDeliveryReconciliation({
				ownerId: userId,
				deliveryId,
				now: now.toISOString(),
			})
			if (result.status === 'deferred') await mirror(result.delivery)
			return result
		},
		async listDueStale(now = new Date(), limit?: number) {
			return await mailbox.listDueStaleInboundDeliveries({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
		},
		async claimCleanup(deliveryId: string, now = new Date()) {
			const result = await mailbox.claimInboundDeliveryCleanup({
				ownerId: userId,
				deliveryId,
				now: now.toISOString(),
			})
			if (result.delivery) await mirror(result.delivery)
			return result
		},
		async releaseCleanup(
			deliveryId: string,
			cleanupLease: string,
			now = new Date(),
		) {
			const result = await mailbox.releaseInboundDeliveryCleanup({
				ownerId: userId,
				deliveryId,
				cleanupLease,
				now: now.toISOString(),
			})
			if (result.status === 'released') await mirror(result.delivery)
			return result
		},
		async markOrphanCleaned(input: {
			deliveryId: string
			cleanupLease: string
			outcome: 'deleted' | 'delete-failed'
			now?: Date
		}) {
			const result = await mailbox.markInboundDeliveryOrphanCleaned({
				ownerId: userId,
				deliveryId: input.deliveryId,
				cleanupLease: input.cleanupLease,
				outcome: input.outcome,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status === 'orphan-cleaned') await mirror(result.delivery)
			return result
		},
		async pruneExpiredDedupe(now = new Date(), limit?: number) {
			const result = await mailbox.pruneExpiredInboundDedupePointers({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
			await env.APP_DB.prepare(
				`DELETE FROM email_delivery_events
				WHERE id IN (
					SELECT id FROM email_delivery_events
					WHERE user_id = ?
						AND provider = ?
						AND dedupe_expires_at <= ?
					ORDER BY created_at ASC, id ASC
					LIMIT ?
				)`,
			)
				.bind(
					userId,
					mailboxInboundDedupeProvider,
					now.toISOString(),
					limit ?? 20,
				)
				.run()
			return result.pruned
		},
		async claimUsageEffect(input: {
			deliveryId: string
			expectedFinalizationToken?: string
			now?: Date
		}) {
			const result = await mailbox.claimInboundUsageEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				expectedFinalizationToken: input.expectedFinalizationToken,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.delivery) await mirror(result.delivery)
			return result
		},
		async completeUsageEffect(input: {
			deliveryId: string
			usageEffectLease: string
			expectedFinalizationToken: string
			mode: 'recorded' | 'suppressed'
			usageMonth: string
			usageBytes: number
			usageDurationMs: number
			now?: Date
		}) {
			const result = await mailbox.completeInboundUsageEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				usageEffectLease: input.usageEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				mode: input.mode,
				usageMonth: input.usageMonth,
				usageBytes: input.usageBytes,
				usageDurationMs: input.usageDurationMs,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status !== 'lease-lost') await mirror(result.delivery)
			return result
		},
		async claimSubscriptionEffect(input: {
			deliveryId: string
			expectedFinalizationToken?: string
			now?: Date
		}) {
			const result = await mailbox.claimInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				expectedFinalizationToken: input.expectedFinalizationToken,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.delivery) await mirror(result.delivery)
			return result
		},
		async completeSubscriptionEffect(input: {
			deliveryId: string
			subscriptionEffectLease: string
			expectedFinalizationToken: string
			mode: 'complete' | 'suppressed'
			suppressionReason?: string
			now?: Date
		}) {
			const result = await mailbox.completeInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				subscriptionEffectLease: input.subscriptionEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				mode: input.mode,
				suppressionReason: input.suppressionReason,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status !== 'lease-lost') await mirror(result.delivery)
			return result
		},
		async failSubscriptionEffect(input: {
			deliveryId: string
			subscriptionEffectLease: string
			expectedFinalizationToken: string
			error: string
			now?: Date
		}) {
			const result = await mailbox.failInboundSubscriptionEffect({
				ownerId: userId,
				deliveryId: input.deliveryId,
				subscriptionEffectLease: input.subscriptionEffectLease,
				expectedFinalizationToken: input.expectedFinalizationToken,
				error: input.error,
				now: (input.now ?? new Date()).toISOString(),
			})
			if (result.status !== 'lease-lost') await mirror(result.delivery)
			return result
		},
		async listDueEffects(now = new Date(), limit?: number) {
			return await mailbox.listDueInboundEffectWork({
				ownerId: userId,
				now: now.toISOString(),
				limit,
			})
		},
	}
}
