import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import PostalMime from 'postal-mime'
import {
	buildEntitlementUpgradeHint,
	EntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { type PlanName } from '#worker/entitlements/plans.ts'
import {
	emailRawMimeKey,
	getEmailMessageById,
	insertEmailAttachments,
	listEmailAttachmentsForMessage,
} from './repo.ts'
import { systemEmailDayKey, type SystemEmailLocal } from './system-email.ts'
import { type EmailDeliveryEventType } from './types.ts'

const inboundProvider = 'cloudflare-email-routing'
export const staleInboundDeliveryAgeMs = 48 * 60 * 60 * 1000
const staleInboundDeliveryBatchSize = 20
const inboundStorageLeaseMs = 5 * 60 * 1000
export const inboundDeliveryDedupeWindowMs = 48 * 60 * 60 * 1000
export const inboundDeliveryCompatibilityWindowMs = 48 * 60 * 60 * 1000

export type InboundDelivery = {
	fingerprint: string
	deliveryId: string
	messageId: string
	threadId: string
	rawMimeKey: string
	userId: string
	inboxId: string
	recipient: string
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
}

type InboundDeliveryEventRow = {
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
	rawMime: string
	quotaDay: string
	now?: Date
}): Promise<InboundDelivery> {
	const now = input.now ?? new Date()
	const fingerprintInput = new TextEncoder().encode(
		`${input.userId}\u0000${input.recipient}\u0000${input.rawMime}`,
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
			typeof detail.quotaDay !== 'string' ||
			typeof detail.dedupeExpiresAt !== 'string'
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

export async function getActiveInboundDelivery(input: {
	db: D1Database
	userId: string
	fingerprint: string
	now: Date
}) {
	const row = await input.db
		.prepare(
			`SELECT event_type, detail_json
			FROM email_delivery_events
			WHERE user_id = ?
				AND provider = ?
				AND json_extract(detail_json, '$.fingerprint') = ?
				AND json_extract(detail_json, '$.dedupeExpiresAt') > ?
			ORDER BY created_at DESC, id DESC
			LIMIT 1`,
		)
		.bind(
			input.userId,
			inboundProvider,
			input.fingerprint,
			input.now.toISOString(),
		)
		.first<InboundDeliveryEventRow>()
	return parseInboundDelivery(row)
}

export async function adoptLegacyInboundDelivery(input: {
	db: D1Database
	blobs: R2Bucket
	delivery: InboundDelivery
	rawMime: string
	rawSize: number
	now: Date
}) {
	const cutoff = new Date(
		input.now.getTime() - inboundDeliveryCompatibilityWindowMs,
	).toISOString()
	const rows = await input.db
		.prepare(
			`SELECT id, thread_id, raw_mime_key
			FROM email_messages
			WHERE user_id = ?
				AND inbox_id = ?
				AND direction = 'inbound'
				AND raw_size = ?
				AND created_at >= ?
				AND id NOT LIKE 'email-inbound-message:%'
			ORDER BY created_at DESC, id DESC
			LIMIT 20`,
		)
		.bind(input.delivery.userId, input.delivery.inboxId, input.rawSize, cutoff)
		.all<{
			id: string
			thread_id: string | null
			raw_mime_key: string | null
		}>()
	for (const row of rows.results ?? []) {
		if (!row.raw_mime_key) continue
		const object = await input.blobs.get(row.raw_mime_key)
		if (!object || (await object.text()) !== input.rawMime) continue
		const adopted: InboundDelivery = {
			...input.delivery,
			messageId: row.id,
			threadId: row.thread_id ?? input.delivery.threadId,
			rawMimeKey: row.raw_mime_key,
			state: 'received',
		}
		await input.db
			.prepare(
				`INSERT OR IGNORE INTO email_delivery_events (
					id, message_id, user_id, inbox_id, event_type, provider,
					provider_event_id, detail_json, created_at
				) VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?)`,
			)
			.bind(
				adopted.deliveryId,
				adopted.messageId,
				adopted.userId,
				adopted.inboxId,
				inboundProvider,
				adopted.deliveryId,
				JSON.stringify(adopted),
				input.now.toISOString(),
			)
			.run()
		return await getInboundDelivery({
			db: input.db,
			userId: adopted.userId,
			deliveryId: adopted.deliveryId,
		})
	}
	return null
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
	await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET event_type = 'rejected', detail_json = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			JSON.stringify(detail),
			input.delivery.deliveryId,
			input.delivery.userId,
		)
		.run()
	return detail
}

export async function claimInboundDeliveryStorage(input: {
	db: D1Database
	delivery: InboundDelivery
	expectedAttachmentCount: number
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
			SET detail_json = json_set(
				detail_json,
				'$.state', 'storing',
				'$.storageLease', ?,
				'$.storageLeaseAt', ?,
				'$.expectedAttachmentCount', ?
			)
			WHERE id = ?
				AND user_id = ?
				AND (
					json_extract(detail_json, '$.state') IN ('pending', 'orphan-cleaned')
					OR (
						json_extract(detail_json, '$.state') = 'storing'
						AND json_extract(detail_json, '$.storageLeaseAt') < ?
					)
				)`,
		)
		.bind(
			storageLease,
			storageLeaseAt,
			input.expectedAttachmentCount,
			input.delivery.deliveryId,
			input.delivery.userId,
			expiredBefore,
		)
		.run()
	if (Number(result.meta.changes ?? 0) > 0) {
		return {
			claimed: true as const,
			delivery: {
				...input.delivery,
				state: 'storing' as const,
				storageLease,
				storageLeaseAt,
				expectedAttachmentCount: input.expectedAttachmentCount,
			},
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
}) {
	if (!input.delivery.storageLease) {
		throw new InboundDeliveryLeaseLostError(
			'Inbound delivery finalization requires a storage lease.',
		)
	}
	const detail: InboundDelivery = {
		...input.delivery,
		state: 'received',
	}
	delete detail.storageLease
	delete detail.storageLeaseAt
	const result = await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET message_id = ?, event_type = 'received', detail_json = ?
			WHERE id = ?
				AND user_id = ?
				AND json_extract(detail_json, '$.state') = 'storing'
				AND json_extract(detail_json, '$.storageLease') = ?`,
		)
		.bind(
			input.delivery.messageId,
			JSON.stringify(detail),
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

function parsedAttachmentSize(content: string | ArrayBuffer) {
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
	const object = await input.blobs.get(message.rawMimeKey)
	if (!object) return false
	const parsed = await PostalMime.parse(await object.text(), {
		attachmentEncoding: 'arraybuffer',
	})
	const claim = await claimInboundDeliveryStorage({
		db: input.db,
		delivery: input.delivery,
		expectedAttachmentCount: parsed.attachments.length,
		now: input.now,
	})
	if (!claim.claimed) return claim.delivery?.state === 'received'
	try {
		await insertEmailAttachments({
			db: input.db,
			messageId: message.id,
			ignoreConflicts: true,
			inboundDeliveryFence: {
				deliveryId: claim.delivery.deliveryId,
				userId: claim.delivery.userId,
				storageLease: claim.delivery.storageLease,
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

export async function reconcileStaleInboundDeliveries(input: {
	db: D1Database
	blobs: R2Bucket
	userId: string
	now?: Date
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
			`SELECT event_type, detail_json
			FROM email_delivery_events
			WHERE user_id = ?
				AND provider = ?
				AND event_type = 'receive_started'
				AND created_at < ?
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
				)
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
		)
		.bind(
			input.userId,
			inboundProvider,
			cutoff,
			leaseExpiredBefore,
			leaseExpiredBefore,
			staleInboundDeliveryBatchSize,
		)
		.all<InboundDeliveryEventRow>()
	let cleaned = 0
	let recovered = 0
	for (const row of rows.results ?? []) {
		const delivery = parseInboundDelivery(row)
		if (!delivery || delivery.userId !== input.userId) continue
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
				}
			} catch (error) {
				console.warn(
					'inbound-email-partial-delivery-recovery-failed',
					delivery.deliveryId,
					error,
				)
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
					SET detail_json = json_set(detail_json, '$.state', 'pending')
					WHERE id = ?
						AND user_id = ?
						AND json_extract(detail_json, '$.state') = 'cleaning'
						AND json_extract(detail_json, '$.cleanupLease') = ?`,
				)
				.bind(delivery.deliveryId, input.userId, cleanupLease)
				.run()
			continue
		}
		await input.db
			.prepare(
				`UPDATE email_delivery_events
				SET detail_json = json_set(detail_json, '$.state', 'orphan-cleaned')
				WHERE id = ?
					AND user_id = ?
					AND json_extract(detail_json, '$.state') = 'cleaning'
					AND json_extract(detail_json, '$.cleanupLease') = ?`,
			)
			.bind(delivery.deliveryId, input.userId, cleanupLease)
			.run()
		cleaned += 1
	}
	return { recovered, cleaned }
}

export function userInboundQuotaDay(now: Date) {
	return utcDayKey(now)
}

export function systemInboundQuotaDay(now: Date) {
	return systemEmailDayKey(now)
}
