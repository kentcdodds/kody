import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	buildEntitlementUpgradeHint,
	EntitlementLimitError,
} from '#worker/entitlements/errors.ts'
import { type PlanName } from '#worker/entitlements/plans.ts'
import { emailRawMimeKey } from './repo.ts'
import { systemEmailDayKey, type SystemEmailLocal } from './system-email.ts'
import { type EmailDeliveryEventType } from './types.ts'

const inboundProvider = 'cloudflare-email-routing'
const staleInboundDeliveryAgeMs = 48 * 60 * 60 * 1000
const staleInboundDeliveryBatchSize = 20
const inboundStorageLeaseMs = 5 * 60 * 1000

export type InboundDelivery = {
	deliveryId: string
	messageId: string
	threadId: string
	rawMimeKey: string
	userId: string
	inboxId: string
	recipient: string
	quotaDay: string
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
}

type InboundDeliveryEventRow = {
	event_type: EmailDeliveryEventType
	detail_json: string
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
}): Promise<InboundDelivery> {
	const digestInput = new TextEncoder().encode(
		`${input.userId}\u0000${input.recipient}\u0000${input.rawMime}`,
	)
	const digest = bytesToHex(
		new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput)),
	)
	const deliveryId = `email-inbound-delivery:${digest}`
	const messageId = `email-inbound-message:${digest}`
	return {
		deliveryId,
		messageId,
		threadId: `email-inbound-thread:${digest}`,
		rawMimeKey: emailRawMimeKey(input.userId, messageId),
		userId: input.userId,
		inboxId: input.inboxId,
		recipient: input.recipient,
		quotaDay: input.quotaDay,
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
			typeof detail.messageId !== 'string' ||
			typeof detail.threadId !== 'string' ||
			typeof detail.rawMimeKey !== 'string' ||
			typeof detail.userId !== 'string' ||
			typeof detail.inboxId !== 'string' ||
			typeof detail.recipient !== 'string' ||
			typeof detail.quotaDay !== 'string'
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
			deliveryId: detail.deliveryId,
			messageId: detail.messageId,
			threadId: detail.threadId,
			rawMimeKey: detail.rawMimeKey,
			userId: detail.userId,
			inboxId: detail.inboxId,
			recipient: detail.recipient,
			quotaDay: detail.quotaDay,
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
}) {
	const storageLease = crypto.randomUUID()
	const storageLeaseAt = new Date().toISOString()
	const expiredBefore = new Date(
		Date.now() - inboundStorageLeaseMs,
	).toISOString()
	const result = await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET detail_json = json_set(
				detail_json,
				'$.state', 'storing',
				'$.storageLease', ?,
				'$.storageLeaseAt', ?
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
	const detail: InboundDelivery = {
		...input.delivery,
		state: 'received',
	}
	delete detail.storageLease
	delete detail.storageLeaseAt
	await input.db
		.prepare(
			`UPDATE email_delivery_events
			SET message_id = ?, event_type = 'received', detail_json = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			input.delivery.messageId,
			JSON.stringify(detail),
			input.delivery.deliveryId,
			input.delivery.userId,
		)
		.run()
	return detail
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
				)
			ORDER BY created_at ASC, id ASC
			LIMIT ?`,
		)
		.bind(
			input.userId,
			inboundProvider,
			cutoff,
			cutoff,
			staleInboundDeliveryBatchSize,
		)
		.all<InboundDeliveryEventRow>()
	let cleaned = 0
	for (const row of rows.results ?? []) {
		const delivery = parseInboundDelivery(row)
		if (!delivery || delivery.userId !== input.userId) continue
		const claim = await input.db
			.prepare(
				`UPDATE email_delivery_events
				SET detail_json = json_set(detail_json, '$.state', 'cleaning')
				WHERE id = ?
					AND user_id = ?
					AND (
						json_extract(detail_json, '$.state') = 'pending'
						OR (
							json_extract(detail_json, '$.state') = 'storing'
							AND json_extract(detail_json, '$.storageLeaseAt') < ?
						)
					)
					AND NOT EXISTS (
						SELECT 1 FROM email_messages
						WHERE id = ? AND user_id = ?
					)`,
			)
			.bind(
				delivery.deliveryId,
				input.userId,
				delivery.messageId,
				input.userId,
				cutoff,
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
						AND json_extract(detail_json, '$.state') = 'cleaning'`,
				)
				.bind(delivery.deliveryId, input.userId)
				.run()
			continue
		}
		await input.db
			.prepare(
				`UPDATE email_delivery_events
				SET detail_json = json_set(detail_json, '$.state', 'orphan-cleaned')
				WHERE id = ?
					AND user_id = ?
					AND json_extract(detail_json, '$.state') = 'cleaning'`,
			)
			.bind(delivery.deliveryId, input.userId)
			.run()
		cleaned += 1
	}
	return { recovered: 0, cleaned }
}

export function userInboundQuotaDay(now: Date) {
	return utcDayKey(now)
}

export function systemInboundQuotaDay(now: Date) {
	return systemEmailDayKey(now)
}
