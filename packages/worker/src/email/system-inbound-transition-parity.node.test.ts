import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type InboundDelivery } from './inbound-delivery.ts'
import { insertSystemEmailMessage } from './system-email-graph-store.ts'
import {
	chargeSystemInboundDeliveryOnce,
	claimSystemInboundDeliveryStorage,
	claimSystemInboundDeliveryWindow,
	getSystemInboundDelivery,
	markSystemInboundDeliveryReceived,
	markSystemInboundDeliveryRejected,
	reconcileSystemStaleInboundDeliveries,
	releaseSystemInboundDeliveryStorage,
} from './system-inbound-delivery-store.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createDedicatedDatabase() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite.exec(`
		INSERT INTO email_inboxes (
			id, user_id, name, description, enabled, created_at, updated_at
		) VALUES (
			'system-transition-inbox', 'system:email', 'support', '', 1,
			'2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
		)
	`)
	return sqlite
}

function delivery(id: string, now: Date): InboundDelivery {
	return {
		fingerprint: `fingerprint-${id}`,
		deliveryId: `delivery-${id}`,
		messageId: `message-${id}`,
		threadId: `thread-${id}`,
		rawMimeKey: `email-raw:v1:system:email/message-${id}`,
		userId: 'system:email',
		inboxId: 'system-transition-inbox',
		recipient: 'support@example.com',
		envelopeFrom: 'sender@example.net',
		provider: 'cloudflare-email-routing',
		quotaDay: now.toISOString().slice(0, 10),
		dedupeExpiresAt: new Date(
			now.getTime() + 48 * 60 * 60 * 1000,
		).toISOString(),
		state: 'pending',
	}
}

test('dedicated system inbound transitions stay behaviorally exhaustive', async () => {
	using sqlite = createDedicatedDatabase()
	const db = createD1FromSqlite(sqlite)
	const now = new Date('2026-08-03T00:00:00.000Z')
	const rejected = delivery('rejected', now)
	await claimSystemInboundDeliveryWindow({ db, delivery: rejected, now })
	const rejectedCharge = await chargeSystemInboundDeliveryOnce({
		db,
		delivery: rejected,
		localPart: 'support',
		limit: 100,
		now,
	})
	const firstClaim = await claimSystemInboundDeliveryStorage({
		db,
		delivery: rejectedCharge.delivery!,
		expectedAttachmentCount: 0,
		now,
	})
	await releaseSystemInboundDeliveryStorage({
		db,
		delivery: firstClaim.delivery!,
	})
	const released = await getSystemInboundDelivery({
		db,
		deliveryId: rejected.deliveryId,
	})
	const secondClaim = await claimSystemInboundDeliveryStorage({
		db,
		delivery: released!,
		expectedAttachmentCount: 0,
		now,
	})
	await markSystemInboundDeliveryRejected({
		db,
		delivery: secondClaim.delivery!,
		reason: 'dedicated rejection',
	})

	const received = delivery('received', now)
	const receivedCharge = await chargeSystemInboundDeliveryOnce({
		db,
		delivery: received,
		localPart: 'support',
		limit: 100,
		now,
	})
	const receivedClaim = await claimSystemInboundDeliveryStorage({
		db,
		delivery: receivedCharge.delivery!,
		expectedAttachmentCount: 0,
		now,
	})
	await insertSystemEmailMessage({
		db,
		inboundDeliveryFence: {
			deliveryId: receivedClaim.delivery!.deliveryId,
			storageLease: receivedClaim.delivery!.storageLease!,
		},
		message: {
			id: received.messageId,
			inboxId: received.inboxId,
			fromAddress: received.envelopeFrom,
			processingStatus: 'stored',
			rawMimeKey: received.rawMimeKey,
			receivedAt: now.toISOString(),
		},
	})
	await markSystemInboundDeliveryReceived({
		db,
		delivery: receivedClaim.delivery!,
		usageDurationMs: 12,
		usageMonth: '2026-08',
		usageBytes: 34,
	})

	const staleNow = new Date('2026-07-01T00:00:00.000Z')
	const stale = delivery('stale', staleNow)
	await chargeSystemInboundDeliveryOnce({
		db,
		delivery: stale,
		localPart: 'support',
		limit: 100,
		now: staleNow,
	})
	const reconciliation = await reconcileSystemStaleInboundDeliveries({
		db,
		blobs: { delete: async () => undefined } as R2Bucket,
		now,
	})
	const receivedProjection = await db
		.prepare(
			`SELECT needs_effect_reconcile
			FROM system_email_delivery_events
			WHERE id = ?`,
		)
		.bind(received.deliveryId)
		.first<{ needs_effect_reconcile: number }>()

	expect({
		firstClaim: firstClaim.delivery?.state,
		retryClaim: secondClaim.delivery?.state,
		rejected: (
			await getSystemInboundDelivery({
				db,
				deliveryId: rejected.deliveryId,
			})
		)?.state,
		received: (
			await getSystemInboundDelivery({
				db,
				deliveryId: received.deliveryId,
			})
		)?.state,
		stale: (
			await getSystemInboundDelivery({
				db,
				deliveryId: stale.deliveryId,
			})
		)?.state,
		receivedNeedsEffectReconcile:
			receivedProjection?.needs_effect_reconcile ?? null,
		reconciliation,
	}).toEqual({
		firstClaim: 'storing',
		retryClaim: 'storing',
		rejected: 'rejected',
		received: 'received',
		stale: 'orphan-cleaned',
		receivedNeedsEffectReconcile: 1,
		reconciliation: expect.objectContaining({ cleaned: 1, recovered: 0 }),
	})
})
