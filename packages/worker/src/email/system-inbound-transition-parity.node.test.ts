import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	chargeSystemInboundDeliveryOnce as chargeLegacySystemInboundDeliveryOnce,
	claimInboundDeliveryStorage,
	claimInboundDeliveryWindow,
	getInboundDelivery,
	markInboundDeliveryReceived,
	markInboundDeliveryRejected,
	reconcileStaleInboundDeliveries,
	releaseInboundDeliveryStorage,
	type InboundDelivery,
} from './inbound-delivery.ts'
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

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function applyMigration(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

function createDatabase(authority: 'legacy' | 'dedicated') {
	const sqlite = new DatabaseSync(':memory:')
	if (authority === 'legacy') {
		applyMigrationsBefore(sqlite, '0130-system-email-graph-expand.sql')
	} else {
		applyMigrationsBefore(sqlite, '0130-system-email-graph-expand.sql')
		applyMigration(sqlite, '0130-system-email-graph-expand.sql')
		applyMigration(sqlite, '0131-system-email-graph-authority.sql')
	}
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

async function insertLegacyMessage(db: D1Database, item: InboundDelivery) {
	await db
		.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, inbox_id, from_address, processing_status,
				raw_mime_key, received_at, created_at, updated_at
			) VALUES (?, 'inbound', 'system:email', ?, ?, 'stored', ?, ?, ?, ?)`,
		)
		.bind(
			item.messageId,
			item.inboxId,
			item.envelopeFrom,
			item.rawMimeKey,
			'2026-08-03T00:00:00.000Z',
			'2026-08-03T00:00:00.000Z',
			'2026-08-03T00:00:00.000Z',
		)
		.run()
}

async function runLegacyTransitions(db: D1Database) {
	const now = new Date('2026-08-03T00:00:00.000Z')
	const rejected = delivery('rejected', now)
	await claimInboundDeliveryWindow({ db, delivery: rejected, now })
	const rejectedCharge = await chargeLegacySystemInboundDeliveryOnce({
		db,
		delivery: rejected,
		localPart: 'support',
		limit: 100,
		now,
	})
	const firstClaim = await claimInboundDeliveryStorage({
		db,
		delivery: rejectedCharge.delivery!,
		expectedAttachmentCount: 0,
		now,
	})
	await releaseInboundDeliveryStorage({ db, delivery: firstClaim.delivery! })
	const released = await getInboundDelivery({
		db,
		userId: 'system:email',
		deliveryId: rejected.deliveryId,
	})
	const secondClaim = await claimInboundDeliveryStorage({
		db,
		delivery: released!,
		expectedAttachmentCount: 0,
		now,
	})
	await markInboundDeliveryRejected({
		db,
		delivery: secondClaim.delivery!,
		reason: 'parity rejection',
	})

	const received = delivery('received', now)
	const receivedCharge = await chargeLegacySystemInboundDeliveryOnce({
		db,
		delivery: received,
		localPart: 'support',
		limit: 100,
		now,
	})
	const receivedClaim = await claimInboundDeliveryStorage({
		db,
		delivery: receivedCharge.delivery!,
		expectedAttachmentCount: 0,
		now,
	})
	await insertLegacyMessage(db, received)
	await markInboundDeliveryReceived({
		db,
		delivery: receivedClaim.delivery!,
		usageDurationMs: 12,
		usageMonth: '2026-08',
		usageBytes: 34,
	})

	const staleNow = new Date('2026-07-01T00:00:00.000Z')
	const stale = delivery('stale', staleNow)
	await chargeLegacySystemInboundDeliveryOnce({
		db,
		delivery: stale,
		localPart: 'support',
		limit: 100,
		now: staleNow,
	})
	const reconciliation = await reconcileStaleInboundDeliveries({
		db,
		blobs: { delete: async () => undefined } as R2Bucket,
		userId: 'system:email',
		now,
	})
	const receivedProjection = await db
		.prepare(
			`SELECT needs_effect_reconcile
			FROM email_delivery_events
			WHERE id = ? AND user_id = 'system:email'`,
		)
		.bind(received.deliveryId)
		.first<{ needs_effect_reconcile: number }>()
	return {
		firstClaim: firstClaim.delivery?.state,
		retryClaim: secondClaim.delivery?.state,
		rejected: (
			await getInboundDelivery({
				db,
				userId: 'system:email',
				deliveryId: rejected.deliveryId,
			})
		)?.state,
		received: (
			await getInboundDelivery({
				db,
				userId: 'system:email',
				deliveryId: received.deliveryId,
			})
		)?.state,
		stale: (
			await getInboundDelivery({
				db,
				userId: 'system:email',
				deliveryId: stale.deliveryId,
			})
		)?.state,
		receivedNeedsEffectReconcile:
			receivedProjection?.needs_effect_reconcile ?? null,
		reconciliation,
	}
}

async function runDedicatedTransitions(db: D1Database) {
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
		reason: 'parity rejection',
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
	return {
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
	}
}

test('legacy and dedicated system inbound transitions stay behaviorally exhaustive', async () => {
	using legacy = createDatabase('legacy')
	const legacyResult = await runLegacyTransitions(createD1FromSqlite(legacy))
	using dedicated = createDatabase('dedicated')
	const dedicatedResult = await runDedicatedTransitions(
		createD1FromSqlite(dedicated),
	)

	expect(legacyResult).toEqual({
		firstClaim: 'storing',
		retryClaim: 'storing',
		rejected: 'rejected',
		received: 'received',
		stale: 'orphan-cleaned',
		receivedNeedsEffectReconcile: 1,
		reconciliation: expect.objectContaining({ cleaned: 1, recovered: 0 }),
	})
	expect(dedicatedResult).toEqual(legacyResult)
})
