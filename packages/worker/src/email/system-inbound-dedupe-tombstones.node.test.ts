import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type InboundDelivery } from './inbound-delivery.ts'
import {
	deleteSystemEmailMessageById,
	insertSystemEmailMessage,
} from './system-email-graph-store.ts'
import {
	systemInboundDeletedRejectionReason,
	systemInboundDedupePointerId,
} from './system-inbound-dedupe.ts'
import {
	chargeSystemInboundDeliveryOnce,
	claimSystemInboundDeliveryStorage,
	claimSystemInboundDeliveryWindow,
	getSystemInboundDelivery,
	getSystemInboundDeliveryWindow,
	markSystemInboundDeliveryReceived,
} from './system-inbound-delivery-store.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createDedicatedDatabase() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite.exec(`
		INSERT INTO email_inboxes (
			id, user_id, name, description, enabled, created_at, updated_at
		) VALUES (
			'system-tombstone-inbox', 'system:email', 'abuse', '', 1,
			'2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
		)
	`)
	return sqlite
}

function delivery(now: Date): InboundDelivery {
	return {
		fingerprint: 'fingerprint-tombstone',
		deliveryId: 'delivery-tombstone',
		messageId: 'message-tombstone',
		threadId: 'thread-tombstone',
		rawMimeKey: 'email-raw:v1:system:email/message-tombstone',
		userId: 'system:email',
		inboxId: 'system-tombstone-inbox',
		recipient: 'abuse@example.com',
		envelopeFrom: 'phish@example.net',
		provider: 'cloudflare-email-routing',
		quotaDay: now.toISOString().slice(0, 10),
		dedupeExpiresAt: new Date(
			now.getTime() + 48 * 60 * 60 * 1000,
		).toISOString(),
		state: 'pending',
	}
}

test('system email delete tombstones the inbound pointer and refuses a matching re-charge', async () => {
	using sqlite = createDedicatedDatabase()
	const db = createD1FromSqlite(sqlite)
	const now = new Date('2026-10-08T00:00:00.000Z')
	const target = delivery(now)
	await claimSystemInboundDeliveryWindow({ db, delivery: target, now })
	const charged = (
		await chargeSystemInboundDeliveryOnce({
			db,
			delivery: target,
			localPart: 'abuse',
			limit: 100,
			now,
		})
	).delivery!
	const claimed = (
		await claimSystemInboundDeliveryStorage({
			db,
			delivery: charged,
			expectedAttachmentCount: 0,
			now,
		})
	).delivery!
	await insertSystemEmailMessage({
		db,
		inboundDeliveryFence: {
			deliveryId: claimed.deliveryId,
			storageLease: claimed.storageLease!,
		},
		message: {
			id: target.messageId,
			inboxId: target.inboxId,
			fromAddress: target.envelopeFrom,
			processingStatus: 'stored',
			rawMimeKey: target.rawMimeKey,
			receivedAt: now.toISOString(),
		},
	})
	await markSystemInboundDeliveryReceived({
		db,
		delivery: claimed,
		usageDurationMs: 8,
		usageMonth: '2026-10',
		usageBytes: 16,
	})

	await deleteSystemEmailMessageById({
		db,
		blobs: { delete: async () => undefined } as unknown as R2Bucket,
		messageId: target.messageId,
	})

	const window = await getSystemInboundDeliveryWindow({
		db,
		fingerprint: target.fingerprint,
		now,
	})
	expect(window).toMatchObject({
		state: 'rejected',
		rejectionReason: systemInboundDeletedRejectionReason,
		deliveryId: target.deliveryId,
	})
	expect(
		await getSystemInboundDelivery({
			db,
			deliveryId: target.deliveryId,
		}),
	).toBeNull()
	const pointerRow = sqlite
		.prepare(
			`SELECT id, state, event_type, message_id
			FROM system_email_delivery_events
			WHERE id = ?`,
		)
		.get(systemInboundDedupePointerId(target.fingerprint)) as {
		id: string
		state: string
		event_type: string
		message_id: string | null
	}
	expect(pointerRow).toEqual({
		id: systemInboundDedupePointerId(target.fingerprint),
		state: 'rejected',
		event_type: 'rejected',
		message_id: null,
	})

	const reclaimed = await claimSystemInboundDeliveryWindow({
		db,
		delivery: { ...target, state: 'pending' },
		now,
	})
	expect(reclaimed).toMatchObject({
		state: 'rejected',
		rejectionReason: systemInboundDeletedRejectionReason,
	})
	const recharge = await chargeSystemInboundDeliveryOnce({
		db,
		delivery: target,
		localPart: 'abuse',
		limit: 100,
		now,
	})
	expect(recharge).toEqual({
		delivery: expect.objectContaining({
			state: 'rejected',
			rejectionReason: systemInboundDeletedRejectionReason,
		}),
		overLimit: false,
	})
	expect(
		await getSystemInboundDelivery({
			db,
			deliveryId: target.deliveryId,
		}),
	).toBeNull()
	const counter = sqlite
		.prepare(
			`SELECT count FROM system_email_daily_counters
			WHERE local_part = 'abuse' AND day = ?`,
		)
		.get(target.quotaDay) as { count: number }
	expect(counter.count).toBe(1)
})
