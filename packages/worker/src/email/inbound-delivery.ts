import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import PostalMime from 'postal-mime'
import {
	buildEntitlementUpgradeHint,
	EntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { type PlanName } from '#worker/entitlements/plans.ts'
import { normalizeEmailAddress } from './address.ts'
import {
	emailRawMimeKey,
	getEmailMessageById,
	insertEmailAttachments,
	listEmailAttachmentsForMessage,
} from './repo.ts'
import { systemEmailDayKey, type SystemEmailLocal } from './system-email.ts'
import { type EmailDeliveryEventType } from './types.ts'

const inboundProvider = 'cloudflare-email-routing'
const inboundDedupeProvider = 'cloudflare-email-routing-dedupe'
export const staleInboundDeliveryAgeMs = 48 * 60 * 60 * 1000
const staleInboundDeliveryBatchSize = 20
const inboundStorageLeaseMs = 5 * 60 * 1000
const inboundReconciliationRetryMs = 15 * 60 * 1000
const inboundOrphanVerificationMs = 60 * 60 * 1000
export const inboundDeliveryDedupeWindowMs = 48 * 60 * 60 * 1000

export type InboundDelivery = {
	fingerprint: string
	deliveryId: string
	messageId: string
	threadId: string
	rawMimeKey: string
	userId: string
	inboxId: string
	recipient: string
	envelopeFrom: string
	provider: string
	quotaDay: string
	dedupeExpiresAt: string
	state:
		| 'pending'
		| 'storing'
		| 'cleaning'
		| 'received'
		| 'rejected'
		| 'orphan-cleaned'
	rejectionReason?: string
	storageLease?: string
	storageLeaseAt?: string
	expectedAttachmentCount?: number
	cleanupLease?: string
	cleanupLeaseAt?: string
	finalizationToken?: string
	usageEffectRecordedAt?: string
	usageEffectSuppressedAt?: string
	usageStartedAt?: string
	usageDurationMs?: number
	usageMonth?: string
	usageBytes?: number
	usageEffectRetryAt?: string
	usageEffectLease?: string
	usageEffectLeaseAt?: string
	subscriptionEffectState?:
		| 'pending'
		| 'processing'
		| 'complete'
		| 'dead-letter'
	subscriptionEffectLease?: string
	subscriptionEffectLeaseAt?: string
	subscriptionEffectRetryAt?: string
	subscriptionEffectAttemptCount?: number
	subscriptionEffectDeadLetterAt?: string
	subscriptionEffectLastError?: string
}

type InboundDeliveryEventRow = {
	id?: string
	event_type: EmailDeliveryEventType
	detail_json: string
}

export class InboundDeliveryLeaseLostError extends Error {
	override name = 'InboundDeliveryLeaseLostError'
}

function randomOperationTimestamp(now: Date) {
	const suffix = (crypto.getRandomValues(new Uint32Array(1)).at(0) ?? 0)
		.toString()
		.padStart(10, '0')
	return now.toISOString().replace('Z', `${suffix}Z`)
}

function bytesToHex(bytes: Uint8Array) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

export async function buildInboundDelivery(input: {
	userId: string
	inboxId: string
	recipient: string
	envelopeFrom?: string
	provider?: string
	rawMime: string
	quotaDay: string
	now?: Date
}): Promise<InboundDelivery> {
	const now = input.now ?? new Date()
	const envelopeFrom =
		normalizeEmailAddress(input.envelopeFrom ?? '') ??
		(input.envelopeFrom ?? '').trim().toLowerCase()
	const provider = input.provider ?? inboundProvider
	const fingerprintInput = new TextEncoder().encode(
		`${input.userId}\u0000${input.recipient}\u0000${envelopeFrom}\u0000${provider}\u0000${input.rawMime}`,
	)
	const fingerprint = bytesToHex(
		new Uint8Array(await crypto.subtle.digest('SHA-256', fingerprintInput)),
	)
	const window = Math.floor(
		now.getTime() / inboundDeliveryDedupeWindowMs,
	).toString(36)
	const digestInput = new TextEncoder().encode(`${fingerprint}\u0000${window}`)
	const deliveryDigest = bytesToHex(
		new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput)),
	)
	const deliveryId = `email-inbound-delivery:${deliveryDigest}`
	const messageId = `email-inbound-message:${deliveryDigest}`
	return {
		fingerprint,
		deliveryId,
		messageId,
		threadId: `email-inbound-thread:${deliveryDigest}`,
		rawMimeKey: emailRawMimeKey(input.userId, messageId),
		userId: input.userId,
		inboxId: input.inboxId,
		recipient: input.recipient,
		envelopeFrom,
		provider,
		quotaDay: input.quotaDay,
		dedupeExpiresAt: new Date(
			now.getTime() + inboundDeliveryDedupeWindowMs,
		).toISOString(),
		state: 'pending',
	}
}

function parseInboundDelivery(
	row: InboundDeliveryEventRow | null,
): InboundDelivery | null {
	if (!row) return null
	try {
		const detail = JSON.parse(row.detail_json) as Partial<InboundDelivery>
		if (
			typeof detail.deliveryId !== 'string' ||
			typeof detail.fingerprint !== 'string' ||
			typeof detail.messageId !== 'string' ||
			typeof detail.threadId !== 'string' ||
			typeof detail.rawMimeKey !== 'string' ||
			typeof detail.userId !== 'string' ||
			typeof detail.inboxId !== 'string' ||
			typeof detail.recipient !== 'string' ||
			typeof detail.envelopeFrom !== 'string' ||
			typeof detail.provider !== 'string' ||
			typeof detail.quotaDay !== 'string' ||
			typeof detail.dedupeExpiresAt !== 'string'
		) {
			return null
		}
		if (
			detail.rawMimeKey !== emailRawMimeKey(detail.userId, detail.messageId)
		) {
			return null
		}
		const state =
			detail.state === 'storing' ||
			detail.state === 'cleaning' ||
			detail.state === 'received' ||
			detail.state === 'rejected' ||
			detail.state === 'orphan-cleaned'
				? detail.state
				: 'pending'
		return {
			fingerprint: detail.fingerprint,
			deliveryId: detail.deliveryId,
			messageId: detail.messageId,
			threadId: detail.threadId,
			rawMimeKey: detail.rawMimeKey,
			userId: detail.userId,
			inboxId: detail.inboxId,
			recipient: detail.recipient,
			envelopeFrom: detail.envelopeFrom,
			provider: detail.provider,
			quotaDay: detail.quotaDay,
			dedupeExpiresAt: detail.dedupeExpiresAt,
			state,
			...(typeof detail.rejectionReason === 'string'
				? { rejectionReason: detail.rejectionReason }
				: {}),
			...(typeof detail.storageLease === 'string'
				? { storageLease: detail.storageLease }
				: {}),
			...(typeof detail.storageLeaseAt === 'string'
				? { storageLeaseAt: detail.storageLeaseAt }
				: {}),
			...(typeof detail.expectedAttachmentCount === 'number'
				? { expectedAttachmentCount: detail.expectedAttachmentCount }
				: {}),
			...(typeof detail.cleanupLease === 'string'
				? { cleanupLease: detail.cleanupLease }
				: {}),
			...(typeof detail.cleanupLeaseAt === 'string'
				? { cleanupLeaseAt: detail.cleanupLeaseAt }
				: {}),
			...(typeof detail.finalizationToken === 'string'
				? { finalizationToken: detail.finalizationToken }
				: {}),
			...(typeof detail.usageEffectRecordedAt === 'string'
				? { usageEffectRecordedAt: detail.usageEffectRecordedAt }
				: {}),
			...(typeof detail.usageEffectSuppressedAt === 'string'
				? { usageEffectSuppressedAt: detail.usageEffectSuppressedAt }
				: {}),
			...(typeof detail.usageStartedAt === 'string'
				? { usageStartedAt: detail.usageStartedAt }
				: {}),
			...(typeof detail.usageDurationMs === 'number'
				? { usageDurationMs: detail.usageDurationMs }
				: {}),
			...(typeof detail.usageMonth === 'string'
				? { usageMonth: detail.usageMonth }
				: {}),
			...(typeof detail.usageBytes === 'number'
				? { usageBytes: detail.usageBytes }
				: {}),
			...(typeof detail.usageEffectRetryAt === 'string'
				? { usageEffectRetryAt: detail.usageEffectRetryAt }
				: {}),
			...(typeof detail.usageEffectLease === 'string'
				? { usageEffectLease: detail.usageEffectLease }
				: {}),
			...(typeof detail.usageEffectLeaseAt === 'string'
				? { usageEffectLeaseAt: detail.usageEffectLeaseAt }
				: {}),
			...(detail.subscriptionEffectState === 'pending' ||
			detail.subscriptionEffectState === 'processing' ||
			detail.subscriptionEffectState === 'complete' ||
			detail.subscriptionEffectState === 'dead-letter'
				? { subscriptionEffectState: detail.subscriptionEffectState }
				: {}),
			...(typeof detail.subscriptionEffectLease === 'string'
				? { subscriptionEffectLease: detail.subscriptionEffectLease }
				: {}),
			...(typeof detail.subscriptionEffectLeaseAt === 'string'
				? { subscriptionEffectLeaseAt: detail.subscriptionEffectLeaseAt }
				: {}),
			...(typeof detail.subscriptionEffectRetryAt === 'string'
				? { subscriptionEffectRetryAt: detail.subscriptionEffectRetryAt }
				: {}),
			...(typeof detail.subscriptionEffectAttemptCount === 'number'
				? {
						subscriptionEffectAttemptCount:
							detail.subscriptionEffectAttemptCount,
					}
				: {}),
			...(typeof detail.subscriptionEffectDeadLetterAt === 'string'
				? {
						subscriptionEffectDeadLetterAt:
							detail.subscriptionEffectDeadLetterAt,
					}
				: {}),
			...(typeof detail.subscriptionEffectLastError === 'string'
				? { subscriptionEffectLastError: detail.subscriptionEffectLastError }
				: {}),
		}
	} catch {
		return null
	}
}

export async function getInboundDelivery(input: {
	db: D1Database
	userId: string
	deliveryId: string
}) {
	const row = await input.db
		.prepare(
			`SELECT event_type, detail_json
			FROM email_delivery_events
			WHERE id = ?
				AND user_id = ?
				AND provider = ?
			LIMIT 1`,
		)
		.bind(input.deliveryId, input.userId, inboundProvider)
		.first<InboundDeliveryEventRow>()
	return parseInboundDelivery(row)
}

export async function claimInboundDeliveryWindow(input: {
	db: D1Database
	delivery: InboundDelivery
	now: Date
}) {
	const pointerId = `email-inbound-dedupe:${input.delivery.fingerprint}`
	const row = await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, inbox_id, event_type, provider,
				provider_event_id, detail_json, created_at
			) VALUES (?, NULL, ?, ?, 'receive_started', ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				inbox_id = excluded.inbox_id,
				detail_json = excluded.detail_json,
				created_at = excluded.created_at
			WHERE email_delivery_events.user_id = excluded.user_id
				AND json_extract(
					email_delivery_events.detail_json,
					'$.dedupeExpiresAt'
				) <= ?
			RETURNING event_type, detail_json`,
		)
		.bind(
			pointerId,
			input.delivery.userId,
			input.delivery.inboxId,
			inboundDedupeProvider,
			pointerId,
			JSON.stringify(input.delivery),
			input.now.toISOString(),
			input.now.toISOString(),
		)
		.first<InboundDeliveryEventRow>()
	if (row) return parseInboundDelivery(row) ?? input.delivery
	const existing = await input.db
		.prepare(
			`SELECT event_type, detail_json
			FROM email_delivery_events
			WHERE id = ? AND user_id = ? AND provider = ?
			LIMIT 1`,
		)
		.bind(pointerId, input.delivery.userId, inboundDedupeProvider)
		.first<InboundDeliveryEventRow>()
	const claimed = parseInboundDelivery(existing)
	if (!claimed) {
		throw new Error('Failed to resolve the inbound delivery dedupe window.')
	}
	return claimed
}

export async function getInboundDeliveryWindow(input: {
	db: D1Database
	userId: string
	fingerprint: string
	now: Date
}) {
	const pointerId = `email-inbound-dedupe:${input.fingerprint}`
	const row = await input.db
		.prepare(
			`SELECT event_type, detail_json
			FROM email_delivery_events
			WHERE id = ? AND user_id = ? AND provider = ?
				AND json_extract(detail_json, '$.dedupeExpiresAt') > ?
			LIMIT 1`,
		)
		.bind(
			pointerId,
			input.userId,
			inboundDedupeProvider,
			input.now.toISOString(),
		)
		.first<InboundDeliveryEventRow>()
	return parseInboundDelivery(row)
}

export async function pruneExpiredInboundDedupePointers(input: {
	db: D1Database
	userId: string
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	const rows = await input.db
		.prepare(
			`SELECT id
			FROM email_delivery_events
			WHERE user_id = ?
				AND provider = ?
				AND json_extract(detail_json, '$.dedupeExpiresAt') <= ?
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
		)
		.bind(
			input.userId,
			inboundDedupeProvider,
			now.toISOString(),
			input.limit ?? 20,
		)
		.all<{ id: string }>()
	const ids = (rows.results ?? []).map((row) => row.id)
	if (ids.length === 0) return 0
	const results = await input.db.batch(
		ids.map((id) =>
			input.db
				.prepare(
					`DELETE FROM email_delivery_events
					WHERE id = ?
						AND user_id = ?
						AND provider = ?
						AND json_extract(detail_json, '$.dedupeExpiresAt') <= ?`,
				)
				.bind(id, input.userId, inboundDedupeProvider, now.toISOString()),
		),
	)
	return results.reduce(
		(total, result) => total + Number(result.meta.changes ?? 0),
		0,
	)
}

async function readCounter(input: {
	db: D1Database
	table: 'entitlement_daily_counters' | 'system_email_daily_counters'
	userId?: string
	localPart?: SystemEmailLocal
	day: string
}) {
	if (input.table === 'entitlement_daily_counters') {
		const row = await input.db
			.prepare(
				`SELECT count FROM entitlement_daily_counters
				WHERE user_id = ?
					AND resource = 'email_receives_per_day'
					AND day = ?`,
			)
			.bind(input.userId, input.day)
			.first<{ count: number }>()
		return Number(row?.count ?? 0)
	}
	const row = await input.db
		.prepare(
			`SELECT count FROM system_email_daily_counters
			WHERE local_part = ? AND day = ?`,
		)
		.bind(input.localPart, input.day)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function readUserInboundReceiveCount(input: {
	db: D1Database
	userId: string
	day: string
}) {
	return await readCounter({
		db: input.db,
		table: 'entitlement_daily_counters',
		userId: input.userId,
		day: input.day,
	})
}

export async function readSystemInboundReceiveCount(input: {
	db: D1Database
	localPart: SystemEmailLocal
	day: string
}) {
	return await readCounter({
		db: input.db,
		table: 'system_email_daily_counters',
		localPart: input.localPart,
		day: input.day,
	})
}

async function resolveConcurrentDelivery(input: {
	db: D1Database
	delivery: InboundDelivery
}) {
	return await getInboundDelivery({
		db: input.db,
		userId: input.delivery.userId,
		deliveryId: input.delivery.deliveryId,
	})
}

export async function chargeUserInboundDeliveryOnce(input: {
	db: D1Database
	delivery: InboundDelivery
	plan: PlanName
	limit: number
	now: Date
}): Promise<InboundDelivery> {
	const existing = await resolveConcurrentDelivery(input)
	if (existing) return existing
	const current = await readCounter({
		db: input.db,
		table: 'entitlement_daily_counters',
		userId: input.delivery.userId,
		day: input.delivery.quotaDay,
	})
	const throwLimitError = (): never => {
		throw new EntitlementLimitError({
			resource: 'email_receives_per_day',
			plan: input.plan,
			limit: input.limit,
			current,
			upgradeHint: buildEntitlementUpgradeHint('email_receives_per_day'),
		})
	}
	if (input.limit < 1 || current >= input.limit) throwLimitError()
	const operationTimestamp = randomOperationTimestamp(input.now)
	try {
		const results = await input.db.batch([
			input.db
				.prepare(
					`INSERT INTO entitlement_daily_counters (
						user_id, resource, day, count, updated_at
					) VALUES (?, 'email_receives_per_day', ?, 1, ?)
					ON CONFLICT(user_id, resource, day) DO UPDATE SET
						count = entitlement_daily_counters.count + 1,
						updated_at = excluded.updated_at
					WHERE entitlement_daily_counters.count + 1 <= ?
						AND NOT EXISTS (
							SELECT 1 FROM email_delivery_events
							WHERE id = ? AND user_id = ?
						)`,
				)
				.bind(
					input.delivery.userId,
					input.delivery.quotaDay,
					operationTimestamp,
					input.limit,
					input.delivery.deliveryId,
					input.delivery.userId,
				),
			input.db
				.prepare(
					`INSERT OR IGNORE INTO email_delivery_events (
						id, message_id, user_id, inbox_id, event_type, provider,
						provider_event_id, detail_json, created_at
					)
					SELECT ?, NULL, ?, ?, 'receive_started', ?, ?, ?, ?
					WHERE EXISTS (
						SELECT 1 FROM entitlement_daily_counters
						WHERE user_id = ?
							AND resource = 'email_receives_per_day'
							AND day = ?
							AND updated_at = ?
					)`,
				)
				.bind(
					input.delivery.deliveryId,
					input.delivery.userId,
					input.delivery.inboxId,
					inboundProvider,
					input.delivery.deliveryId,
					JSON.stringify(input.delivery),
					input.now.toISOString(),
					input.delivery.userId,
					input.delivery.quotaDay,
					operationTimestamp,
				),
		])
		if (Number(results[1]?.meta.changes ?? 0) > 0) return input.delivery
	} catch (error) {
		const committed = await resolveConcurrentDelivery(input).catch(() => null)
		if (committed) return committed
		throw error
	}
	const raced = await resolveConcurrentDelivery(input)
	if (raced) return raced
	return throwLimitError()
}

export async function chargeSystemInboundDeliveryOnce(input: {
	db: D1Database
	delivery: InboundDelivery
	localPart: SystemEmailLocal
	limit: number
	now: Date
}) {
	const existing = await resolveConcurrentDelivery(input)
	if (existing) return { delivery: existing, overLimit: false as const }
	const current = await readCounter({
		db: input.db,
		table: 'system_email_daily_counters',
		localPart: input.localPart,
		day: input.delivery.quotaDay,
	})
	if (input.limit < 1 || current >= input.limit) {
		return { delivery: null, overLimit: true as const }
	}
	const operationTimestamp = randomOperationTimestamp(input.now)
	try {
		const results = await input.db.batch([
			input.db
				.prepare(
					`INSERT INTO system_email_daily_counters (
						local_part, day, count, updated_at
					) VALUES (?, ?, 1, ?)
					ON CONFLICT(local_part, day) DO UPDATE SET
						count = system_email_daily_counters.count + 1,
						updated_at = excluded.updated_at
					WHERE system_email_daily_counters.count + 1 <= ?
						AND NOT EXISTS (
							SELECT 1 FROM email_delivery_events
							WHERE id = ? AND user_id = ?
						)`,
				)
				.bind(
					input.localPart,
					input.delivery.quotaDay,
					operationTimestamp,
					input.limit,
					input.delivery.deliveryId,
					input.delivery.userId,
				),
			input.db
				.prepare(
					`INSERT OR IGNORE INTO email_delivery_events (
						id, message_id, user_id, inbox_id, event_type, provider,
						provider_event_id, detail_json, created_at
					)
					SELECT ?, NULL, ?, ?, 'receive_started', ?, ?, ?, ?
					WHERE EXISTS (
						SELECT 1 FROM system_email_daily_counters
						WHERE local_part = ? AND day = ? AND updated_at = ?
					)`,
				)
				.bind(
					input.delivery.deliveryId,
					input.delivery.userId,
					input.delivery.inboxId,
					inboundProvider,
					input.delivery.deliveryId,
					JSON.stringify(input.delivery),
					input.now.toISOString(),
					input.localPart,
					input.delivery.quotaDay,
					operationTimestamp,
				),
		])
		if (Number(results[1]?.meta.changes ?? 0) > 0) {
			return { delivery: input.delivery, overLimit: false as const }
		}
	} catch (error) {
		const committed = await resolveConcurrentDelivery(input).catch(() => null)
		if (committed) return { delivery: committed, overLimit: false as const }
		throw error
	}
	const raced = await resolveConcurrentDelivery(input)
	return raced
		? { delivery: raced, overLimit: false as const }
		: { delivery: null, overLimit: true as const }
}

export async function markInboundDeliveryRejected(input: {
	db: D1Database
	delivery: InboundDelivery
	reason: string
}) {
	const detail = {
		...input.delivery,
		state: 'rejected' as const,
		rejectionReason: input.reason,
	}
	const expectedLease = input.delivery.storageLease ?? null
	const result = await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET event_type = 'rejected', detail_json = ?
			WHERE id = ?
				AND user_id = ?
				AND event_type = 'receive_started'
				AND json_extract(detail_json, '$.state') = ?
				AND json_extract(detail_json, '$.messageId') = ?
				AND json_extract(detail_json, '$.fingerprint') = ?
				AND (
					(? IS NULL AND json_extract(detail_json, '$.storageLease') IS NULL)
					OR json_extract(detail_json, '$.storageLease') = ?
				)`,
		)
		.bind(
			JSON.stringify(detail),
			input.delivery.deliveryId,
			input.delivery.userId,
			input.delivery.state,
			input.delivery.messageId,
			input.delivery.fingerprint,
			expectedLease,
			expectedLease,
		)
		.run()
	if (Number(result.meta.changes ?? 0) > 0) return true
	const current = await getInboundDelivery({
		db: input.db,
		userId: input.delivery.userId,
		deliveryId: input.delivery.deliveryId,
	})
	if (current?.state === 'rejected') return true
	if (current?.state === 'received') {
		const message = await getEmailMessageById({
			db: input.db,
			userId: current.userId,
			messageId: current.messageId,
		})
		if (message) return false
	}
	throw new InboundDeliveryLeaseLostError(
		'Inbound rejection lost a state race; delivery should be retried.',
	)
}

export async function claimInboundDeliveryStorage(input: {
	db: D1Database
	delivery: InboundDelivery
	expectedAttachmentCount: number
	usageStartedAt?: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const storageLease = crypto.randomUUID()
	const storageLeaseAt = now.toISOString()
	const expiredBefore = new Date(
		now.getTime() - inboundStorageLeaseMs,
	).toISOString()
	const result = await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET event_type = 'receive_started',
				message_id = NULL,
				detail_json = json_set(
				detail_json,
				'$.state', 'storing',
				'$.storageLease', ?,
				'$.storageLeaseAt', ?,
				'$.expectedAttachmentCount', ?,
				'$.usageStartedAt', COALESCE(
					json_extract(detail_json, '$.usageStartedAt'),
					?
				)
			)
			WHERE id = ?
				AND user_id = ?
				AND (
					json_extract(detail_json, '$.state') = 'pending'
					OR (
						json_extract(detail_json, '$.state') = 'storing'
						AND json_extract(detail_json, '$.storageLeaseAt') < ?
					)
					OR (
						json_extract(detail_json, '$.state') = 'received'
						AND NOT EXISTS (
							SELECT 1 FROM email_messages
							WHERE id = json_extract(
								email_delivery_events.detail_json,
								'$.messageId'
							)
								AND user_id = email_delivery_events.user_id
						)
					)
				)`,
		)
		.bind(
			storageLease,
			storageLeaseAt,
			input.expectedAttachmentCount,
			input.usageStartedAt ?? null,
			input.delivery.deliveryId,
			input.delivery.userId,
			expiredBefore,
		)
		.run()
	if (Number(result.meta.changes ?? 0) > 0) {
		const claimed = await getInboundDelivery({
			db: input.db,
			userId: input.delivery.userId,
			deliveryId: input.delivery.deliveryId,
		})
		if (!claimed?.storageLease) {
			throw new InboundDeliveryLeaseLostError(
				'Inbound delivery lease disappeared after it was claimed.',
			)
		}
		return {
			claimed: true as const,
			delivery: claimed,
		}
	}
	return {
		claimed: false as const,
		delivery: await getInboundDelivery({
			db: input.db,
			userId: input.delivery.userId,
			deliveryId: input.delivery.deliveryId,
		}),
	}
}

export async function releaseInboundDeliveryStorage(input: {
	db: D1Database
	delivery: InboundDelivery
}) {
	if (!input.delivery.storageLease) return
	await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET detail_json = json_remove(
				json_remove(
					json_set(detail_json, '$.state', 'pending'),
					'$.storageLease'
				),
				'$.storageLeaseAt'
			)
			WHERE id = ?
				AND user_id = ?
				AND json_extract(detail_json, '$.state') = 'storing'
				AND json_extract(detail_json, '$.storageLease') = ?`,
		)
		.bind(
			input.delivery.deliveryId,
			input.delivery.userId,
			input.delivery.storageLease,
		)
		.run()
}

export async function markInboundDeliveryReceived(input: {
	db: D1Database
	delivery: InboundDelivery
	usageDurationMs: number
	usageMonth: string
	usageBytes: number
}) {
	if (!input.delivery.storageLease) {
		throw new InboundDeliveryLeaseLostError(
			'Inbound delivery finalization requires a storage lease.',
		)
	}
	const detail: InboundDelivery = {
		...input.delivery,
		state: 'received',
		finalizationToken: input.delivery.storageLease,
		subscriptionEffectState: 'pending',
		usageDurationMs:
			input.delivery.usageDurationMs ??
			Math.max(0, Math.round(input.usageDurationMs)),
		usageMonth: input.delivery.usageMonth ?? input.usageMonth,
		usageBytes:
			input.delivery.usageBytes ?? Math.max(0, Math.round(input.usageBytes)),
	}
	delete detail.storageLease
	delete detail.storageLeaseAt
	const usageEffectComplete =
		detail.usageEffectRecordedAt != null ||
		detail.usageEffectSuppressedAt != null
	const subscriptionEffectComplete =
		detail.subscriptionEffectState === 'complete' ||
		detail.subscriptionEffectState === 'dead-letter'
	const result = await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET message_id = ?,
				event_type = 'received',
				detail_json = ?,
				needs_effect_reconcile = ?,
				usage_effect_recorded_at = ?,
				usage_month = ?,
				usage_bytes = ?,
				usage_duration_ms = ?
			WHERE id = ?
				AND user_id = ?
				AND json_extract(detail_json, '$.state') = 'storing'
				AND json_extract(detail_json, '$.storageLease') = ?`,
		)
		.bind(
			input.delivery.messageId,
			JSON.stringify(detail),
			usageEffectComplete && subscriptionEffectComplete ? 0 : 1,
			detail.usageEffectRecordedAt ?? null,
			detail.usageMonth,
			detail.usageBytes,
			detail.usageDurationMs,
			input.delivery.deliveryId,
			input.delivery.userId,
			input.delivery.storageLease,
		)
		.run()
	if (Number(result.meta.changes ?? 0) === 0) {
		const current = await getInboundDelivery({
			db: input.db,
			userId: input.delivery.userId,
			deliveryId: input.delivery.deliveryId,
		})
		if (current?.state === 'received') return current
		throw new InboundDeliveryLeaseLostError(
			'Inbound delivery storage lease was lost before finalization.',
		)
	}
	return detail
}

function parsedAttachmentSize(
	content: string | ArrayBuffer | Uint8Array<ArrayBufferLike>,
) {
	return typeof content === 'string'
		? new TextEncoder().encode(content).byteLength
		: content.byteLength
}

async function recoverCommittedInboundDelivery(input: {
	db: D1Database
	blobs: R2Bucket
	delivery: InboundDelivery
	now: Date
}) {
	const message = await getEmailMessageById({
		db: input.db,
		userId: input.delivery.userId,
		messageId: input.delivery.messageId,
	})
	if (!message?.rawMimeKey) return false
	if (
		message.rawMimeKey !==
		emailRawMimeKey(input.delivery.userId, input.delivery.messageId)
	) {
		throw new Error(
			'Inbound message raw MIME key is outside its user namespace.',
		)
	}
	const object = await input.blobs.get(message.rawMimeKey)
	if (!object) return false
	const parsed = await PostalMime.parse(await object.text(), {
		attachmentEncoding: 'arraybuffer',
	})
	const claim = await claimInboundDeliveryStorage({
		db: input.db,
		delivery: input.delivery,
		expectedAttachmentCount: parsed.attachments.length,
		usageStartedAt: input.delivery.usageStartedAt,
		now: input.now,
	})
	if (!claim.claimed) return claim.delivery?.state === 'received'
	const storageLease = claim.delivery.storageLease
	if (!storageLease) {
		throw new InboundDeliveryLeaseLostError(
			'Recovered inbound delivery has no storage lease.',
		)
	}
	try {
		await insertEmailAttachments({
			db: input.db,
			messageId: message.id,
			ignoreConflicts: true,
			inboundDeliveryFence: {
				deliveryId: claim.delivery.deliveryId,
				userId: claim.delivery.userId,
				storageLease,
			},
			attachments: parsed.attachments.map((attachment, index) => ({
				id: `${message.id}:attachment:${index}`,
				filename: attachment.filename,
				contentType: attachment.mimeType,
				contentId: attachment.contentId ?? null,
				disposition: attachment.disposition,
				size: parsedAttachmentSize(attachment.content),
				storageKind: 'raw-mime',
				storageKey: null,
			})),
		})
		const attachments = await listEmailAttachmentsForMessage({
			db: input.db,
			messageId: message.id,
		})
		if (attachments.length !== parsed.attachments.length) {
			throw new InboundDeliveryLeaseLostError(
				'Inbound attachment recovery did not commit every attachment.',
			)
		}
		await markInboundDeliveryReceived({
			db: input.db,
			delivery: claim.delivery,
			usageDurationMs: claim.delivery.usageStartedAt
				? input.now.getTime() - Date.parse(claim.delivery.usageStartedAt)
				: 0,
			usageMonth: (message.receivedAt ?? message.createdAt).slice(0, 7),
			usageBytes: message.rawSize ?? 0,
		})
		return true
	} catch (error) {
		await releaseInboundDeliveryStorage({
			db: input.db,
			delivery: claim.delivery,
		}).catch(() => undefined)
		throw error
	}
}

async function deferInboundDeliveryReconciliation(input: {
	db: D1Database
	delivery: InboundDelivery
	now: Date
}) {
	await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET detail_json = json_set(detail_json, '$.reconcileAfter', ?)
			WHERE id = ? AND user_id = ? AND event_type = 'receive_started'`,
		)
		.bind(
			new Date(
				input.now.getTime() + inboundReconciliationRetryMs,
			).toISOString(),
			input.delivery.deliveryId,
			input.delivery.userId,
		)
		.run()
}

export async function reconcileStaleInboundDeliveries(input: {
	db: D1Database
	blobs: R2Bucket
	userId: string
	now?: Date
	deadlineMs?: number
}) {
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - staleInboundDeliveryAgeMs,
	).toISOString()
	const leaseExpiredBefore = new Date(
		now.getTime() - inboundStorageLeaseMs,
	).toISOString()
	const rows = await input.db
		.prepare(
			`SELECT id, event_type, detail_json
			FROM email_delivery_events
			WHERE user_id = ?
				AND provider = ?
				AND event_type = 'receive_started'
				AND created_at < ?
				AND (
					json_extract(detail_json, '$.reconcileAfter') IS NULL
					OR json_extract(detail_json, '$.reconcileAfter') <= ?
				)
				AND (
					json_extract(detail_json, '$.state') = 'pending'
					OR (
						json_extract(detail_json, '$.state') = 'storing'
						AND json_extract(detail_json, '$.storageLeaseAt') < ?
					)
					OR (
						json_extract(detail_json, '$.state') = 'cleaning'
						AND json_extract(detail_json, '$.cleanupLeaseAt') < ?
					)
					OR (
						json_extract(detail_json, '$.state') = 'orphan-cleaned'
						AND json_extract(detail_json, '$.cleanupRetryAt') <= ?
					)
				)
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
		)
		.bind(
			input.userId,
			inboundProvider,
			cutoff,
			now.toISOString(),
			leaseExpiredBefore,
			leaseExpiredBefore,
			now.toISOString(),
			staleInboundDeliveryBatchSize,
		)
		.all<InboundDeliveryEventRow>()
	let cleaned = 0
	let recovered = 0
	let budgetExhausted = false
	for (const row of rows.results ?? []) {
		if (input.deadlineMs != null && Date.now() >= input.deadlineMs) {
			budgetExhausted = true
			break
		}
		const delivery = parseInboundDelivery(row)
		if (!delivery || delivery.userId !== input.userId) {
			if (row.id) {
				await input.db
					.prepare(
						`UPDATE email_delivery_events
						SET event_type = 'failed'
						WHERE id = ? AND user_id = ? AND provider = ?`,
					)
					.bind(row.id, input.userId, inboundProvider)
					.run()
			}
			continue
		}
		const message = await getEmailMessageById({
			db: input.db,
			userId: input.userId,
			messageId: delivery.messageId,
		})
		if (message) {
			try {
				if (
					await recoverCommittedInboundDelivery({
						db: input.db,
						blobs: input.blobs,
						delivery,
						now,
					})
				) {
					recovered += 1
				} else {
					await deferInboundDeliveryReconciliation({
						db: input.db,
						delivery,
						now,
					})
				}
			} catch (error) {
				console.warn(
					'inbound-email-partial-delivery-recovery-failed',
					delivery.deliveryId,
					error,
				)
				await deferInboundDeliveryReconciliation({
					db: input.db,
					delivery,
					now,
				}).catch(() => undefined)
			}
			continue
		}
		const cleanupLease = crypto.randomUUID()
		const claim = await input.db
			.prepare(
				`UPDATE email_delivery_events
				SET detail_json = json_set(
					detail_json,
					'$.state', 'cleaning',
					'$.cleanupLease', ?,
					'$.cleanupLeaseAt', ?
				)
				WHERE id = ?
					AND user_id = ?
					AND (
						json_extract(detail_json, '$.state') = 'pending'
						OR (
							json_extract(detail_json, '$.state') = 'storing'
							AND json_extract(detail_json, '$.storageLeaseAt') < ?
						)
						OR (
							json_extract(detail_json, '$.state') = 'cleaning'
							AND json_extract(detail_json, '$.cleanupLeaseAt') < ?
						)
						OR (
							json_extract(detail_json, '$.state') = 'orphan-cleaned'
							AND json_extract(detail_json, '$.cleanupRetryAt') <= ?
						)
					)
					AND NOT EXISTS (
						SELECT 1 FROM email_messages
						WHERE id = ? AND user_id = ?
					)`,
			)
			.bind(
				cleanupLease,
				now.toISOString(),
				delivery.deliveryId,
				input.userId,
				leaseExpiredBefore,
				leaseExpiredBefore,
				now.toISOString(),
				delivery.messageId,
				input.userId,
			)
			.run()
		if (Number(claim.meta.changes ?? 0) === 0) continue
		try {
			await input.blobs.delete(delivery.rawMimeKey)
		} catch (error) {
			console.warn(
				'inbound-email-orphan-blob-delete-failed',
				delivery.rawMimeKey,
				error,
			)
			await input.db
				.prepare(
					`UPDATE email_delivery_events
					SET detail_json = json_remove(
						json_remove(
							json_set(
								detail_json,
								'$.state', 'orphan-cleaned',
								'$.cleanupRetryAt', ?
							),
							'$.cleanupLease'
						),
						'$.cleanupLeaseAt'
					)
					WHERE id = ?
						AND user_id = ?
						AND json_extract(detail_json, '$.state') = 'cleaning'
						AND json_extract(detail_json, '$.cleanupLease') = ?`,
				)
				.bind(
					new Date(now.getTime() + inboundReconciliationRetryMs).toISOString(),
					delivery.deliveryId,
					input.userId,
					cleanupLease,
				)
				.run()
			continue
		}
		await input.db
			.prepare(
				`UPDATE email_delivery_events
				SET detail_json = json_remove(
					json_remove(
						json_set(
							detail_json,
							'$.state', 'orphan-cleaned',
							'$.cleanupRetryAt', ?
						),
						'$.cleanupLease'
					),
					'$.cleanupLeaseAt'
				)
				WHERE id = ?
					AND user_id = ?
					AND json_extract(detail_json, '$.state') = 'cleaning'
					AND json_extract(detail_json, '$.cleanupLease') = ?`,
			)
			.bind(
				new Date(now.getTime() + inboundOrphanVerificationMs).toISOString(),
				delivery.deliveryId,
				input.userId,
				cleanupLease,
			)
			.run()
		cleaned += 1
	}
	return {
		recovered,
		cleaned,
		...(budgetExhausted ? { budgetExhausted: true as const } : {}),
	}
}

export function userInboundQuotaDay(now: Date) {
	return utcDayKey(now)
}

export function systemInboundQuotaDay(now: Date) {
	return systemEmailDayKey(now)
}
