import {
	parseStrictInboundDeliveryDetailJson,
	type InboundDelivery,
} from './inbound-delivery.ts'
import { mailboxRpc, type MailboxEnv } from './mailbox-client.ts'
import {
	detailJsonFromMailboxInboundSnapshot,
	mailboxInboundDedupePointerId,
	mailboxInboundDedupeProvider,
	mailboxInboundProvider,
	needsMailboxEffectReconcile,
	type MailboxInboundDeliverySnapshot,
} from './mailbox-inbound-ledger.ts'
import {
	type MailboxDeliveryEventInput,
	type MailboxInboundDeliveryState,
} from './mailbox-types.ts'
import { systemEmailOwnerId } from './email-owner.ts'

export type UserInboundDeliveryProjectionEnv = {
	APP_DB: D1Database
} & MailboxEnv

export type UserInboundDeliveryProjectionResult =
	| { status: 'mirrored' }
	| { status: 'stale' }

export function toUserInboundDelivery(
	userId: string,
	snapshot: MailboxInboundDeliverySnapshot,
): InboundDelivery {
	const { createdAt: _createdAt, updatedAt: _updatedAt, ...delivery } = snapshot
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
	const isLifecycle = input.provider === mailboxInboundProvider
	const cleanupRetryAt =
		isLifecycle && delivery.state === 'orphan-cleaned'
			? (delivery.cleanupRetryAt ?? null)
			: null
	const reconcileAfter =
		isLifecycle &&
		(delivery.state === 'pending' ||
			delivery.state === 'storing' ||
			delivery.state === 'cleaning' ||
			delivery.state === 'orphan-cleaned')
			? (delivery.reconcileAfter ?? null)
			: null
	return {
		id: input.eventId,
		messageId: delivery.state === 'received' ? delivery.messageId : null,
		inboxId: delivery.inboxId,
		eventType: eventTypeForState(delivery.state),
		provider: input.provider,
		providerMessageId: null,
		providerEventId: input.eventId,
		detailJson: JSON.stringify(delivery),
		needsEffectReconcile:
			delivery.state === 'received' && needsMailboxEffectReconcile(delivery),
		state: delivery.state,
		fingerprint: delivery.fingerprint,
		storageLease: delivery.storageLease ?? null,
		storageLeaseAt: delivery.storageLeaseAt ?? null,
		cleanupLease: delivery.cleanupLease ?? null,
		cleanupLeaseAt: delivery.cleanupLeaseAt ?? null,
		cleanupRetryAt,
		expectedAttachmentCount: delivery.expectedAttachmentCount ?? null,
		finalizationToken: delivery.finalizationToken ?? null,
		reconcileAfter,
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
			`SELECT detail_json, created_at,
				COALESCE(updated_at, created_at) AS updated_at
			FROM email_delivery_events
			WHERE id = ? AND user_id = ? AND provider = ?
			LIMIT 1`,
		)
		.bind(input.eventId, input.userId, input.provider)
		.first<{
			detail_json: string | null
			created_at: string
			updated_at: string
		}>()
}

function validatedBootstrapDelivery(input: {
	detailJson: unknown
	userId: string
	deliveryId?: string
	fingerprint?: string
}) {
	const delivery = parseStrictInboundDeliveryDetailJson(input.detailJson)
	if (!delivery) return null
	if (
		delivery.userId !== input.userId ||
		delivery.provider !== mailboxInboundProvider ||
		(input.deliveryId != null && delivery.deliveryId !== input.deliveryId) ||
		(input.fingerprint != null && delivery.fingerprint !== input.fingerprint)
	) {
		return null
	}
	return delivery
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
}): Promise<UserInboundDeliveryProjectionResult> {
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
	if (Number(result.meta.changes ?? 0) > 0) return { status: 'mirrored' }
	const existing = await input.db
		.prepare(
			`SELECT user_id, provider, COALESCE(updated_at, created_at) AS updated_at
			FROM email_delivery_events
			WHERE id = ?
			LIMIT 1`,
		)
		.bind(eventId)
		.first<{ user_id: string; provider: string; updated_at: string }>()
	if (
		!existing ||
		existing.user_id !== input.userId ||
		existing.provider !== provider
	) {
		throw new Error(
			'Mailbox inbound snapshot failed its D1 owner/provider fence.',
		)
	}
	if (existing.updated_at >= snapshot.updatedAt) return { status: 'stale' }
	throw new Error(
		'Mailbox inbound snapshot was not applied and D1 has no newer projection.',
	)
}

export async function bootstrapUserInboundDeliveryFromD1(input: {
	env: UserInboundDeliveryProjectionEnv
	userId: string
	deliveryId: string
}) {
	if (input.userId === systemEmailOwnerId) return null
	const timestamps = await d1EventTimestamps({
		db: input.env.APP_DB,
		userId: input.userId,
		eventId: input.deliveryId,
		provider: mailboxInboundProvider,
	})
	if (!timestamps) return null
	const delivery = validatedBootstrapDelivery({
		detailJson: timestamps.detail_json,
		userId: input.userId,
		deliveryId: input.deliveryId,
	})
	if (!delivery) {
		console.warn(
			'inbound-email-delivery-bootstrap-row-invalid',
			input.userId,
			input.deliveryId,
		)
		return null
	}
	const mailbox = mailboxRpc({ env: input.env, userId: input.userId })
	await mailbox.bootstrapDeliveryEvents({
		ownerId: input.userId,
		events: [
			toMailboxBootstrapEvent({
				delivery,
				eventId: input.deliveryId,
				provider: mailboxInboundProvider,
				createdAt: timestamps.created_at,
				updatedAt: timestamps.updated_at,
			}),
		],
	})
	return await mailbox.getInboundDelivery({
		ownerId: input.userId,
		deliveryId: input.deliveryId,
	})
}

export async function bootstrapUserInboundDeliveryWindowFromD1(input: {
	env: UserInboundDeliveryProjectionEnv
	userId: string
	fingerprint: string
	now: Date
}) {
	if (input.userId === systemEmailOwnerId) return null
	const eventId = mailboxInboundDedupePointerId(input.fingerprint)
	const timestamps = await d1EventTimestamps({
		db: input.env.APP_DB,
		userId: input.userId,
		eventId,
		provider: mailboxInboundDedupeProvider,
	})
	if (!timestamps) return null
	const delivery = validatedBootstrapDelivery({
		detailJson: timestamps.detail_json,
		userId: input.userId,
		fingerprint: input.fingerprint,
	})
	if (!delivery || delivery.dedupeExpiresAt <= input.now.toISOString()) {
		console.warn(
			'inbound-email-dedupe-bootstrap-row-invalid',
			input.userId,
			eventId,
		)
		return null
	}
	const mailbox = mailboxRpc({ env: input.env, userId: input.userId })
	await mailbox.bootstrapDeliveryEvents({
		ownerId: input.userId,
		events: [
			toMailboxBootstrapEvent({
				delivery,
				eventId,
				provider: mailboxInboundDedupeProvider,
				createdAt: timestamps.created_at,
				updatedAt: timestamps.updated_at,
			}),
		],
	})
	return await mailbox.getInboundDeliveryWindow({
		ownerId: input.userId,
		fingerprint: input.fingerprint,
		now: input.now.toISOString(),
	})
}
