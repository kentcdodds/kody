import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	buildInboundDelivery,
	chargeSystemInboundDeliveryOnce,
	chargeUserInboundDeliveryOnce,
	claimInboundDeliveryStorage,
	claimInboundDeliveryWindow,
	getInboundDelivery,
	getInboundDeliveryWindow,
	markInboundDeliveryReceived,
	markInboundDeliveryRejected,
	pruneExpiredInboundDedupePointers,
	reconcileStaleInboundDeliveries,
	releaseInboundDeliveryStorage,
} from './inbound-delivery.ts'
import { processLegacySystemInboundDeliveryEffectsForRollback } from './inbound-effects.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const rejectionMessage =
	'Legacy system inbound D1 engine is compatibility-only after cutover.'

test('every legacy system inbound authority entry point rejects after the marker', async () => {
	using sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const now = new Date('2026-08-03T00:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId: 'system:email',
		inboxId: 'system-inbox',
		recipient: 'support@example.com',
		envelopeFrom: 'sender@example.net',
		rawMime: 'From: sender@example.net\r\n\r\nhello',
		quotaDay: '2026-08-03',
		now,
	})
	const leasedDelivery = {
		...delivery,
		state: 'storing' as const,
		storageLease: 'legacy-storage-lease',
		storageLeaseAt: now.toISOString(),
	}
	const blobs = {
		get: async () => null,
		delete: async () => undefined,
	} as unknown as R2Bucket
	const calls: ReadonlyArray<{
		name: string
		run: () => Promise<unknown>
	}> = [
		{
			name: 'getInboundDelivery',
			run: async () =>
				await getInboundDelivery({
					db,
					userId: delivery.userId,
					deliveryId: delivery.deliveryId,
				}),
		},
		{
			name: 'claimInboundDeliveryWindow',
			run: async () => await claimInboundDeliveryWindow({ db, delivery, now }),
		},
		{
			name: 'getInboundDeliveryWindow',
			run: async () =>
				await getInboundDeliveryWindow({
					db,
					userId: delivery.userId,
					fingerprint: delivery.fingerprint,
					now,
				}),
		},
		{
			name: 'pruneExpiredInboundDedupePointers',
			run: async () =>
				await pruneExpiredInboundDedupePointers({
					db,
					userId: delivery.userId,
					now,
				}),
		},
		{
			name: 'chargeSystemInboundDeliveryOnce',
			run: async () =>
				await chargeSystemInboundDeliveryOnce({
					db,
					delivery,
					localPart: 'support',
					limit: 10,
					now,
				}),
		},
		{
			name: 'chargeUserInboundDeliveryOnce',
			run: async () =>
				await chargeUserInboundDeliveryOnce({
					db,
					env: {} as Parameters<typeof chargeUserInboundDeliveryOnce>[0]['env'],
					delivery,
					plan: 'pro',
					limit: 10,
					now,
				}),
		},
		{
			name: 'markInboundDeliveryRejected',
			run: async () =>
				await markInboundDeliveryRejected({
					db,
					delivery,
					reason: 'rejected',
				}),
		},
		{
			name: 'claimInboundDeliveryStorage',
			run: async () =>
				await claimInboundDeliveryStorage({
					db,
					delivery,
					expectedAttachmentCount: 0,
					now,
				}),
		},
		{
			name: 'releaseInboundDeliveryStorage',
			run: async () =>
				await releaseInboundDeliveryStorage({ db, delivery: leasedDelivery }),
		},
		{
			name: 'markInboundDeliveryReceived',
			run: async () =>
				await markInboundDeliveryReceived({
					db,
					delivery: leasedDelivery,
					usageDurationMs: 1,
					usageMonth: '2026-08',
					usageBytes: 1,
				}),
		},
		{
			name: 'reconcileStaleInboundDeliveries',
			run: async () =>
				await reconcileStaleInboundDeliveries({
					db,
					blobs,
					userId: delivery.userId,
					now,
				}),
		},
		{
			name: 'processLegacySystemInboundDeliveryEffectsForRollback',
			run: async () =>
				await processLegacySystemInboundDeliveryEffectsForRollback({
					env: {
						APP_DB: db,
					} as Parameters<
						typeof processLegacySystemInboundDeliveryEffectsForRollback
					>[0]['env'],
					userId: delivery.userId,
					deliveryId: delivery.deliveryId,
					now,
				}),
		},
	]

	for (const call of calls) {
		await expect(call.run(), call.name).rejects.toThrow(rejectionMessage)
	}
})
