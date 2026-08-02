import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { buildInboundDelivery } from './inbound-delivery.ts'
import {
	createUserInboundDeliveryAuthority,
	mirrorUserInboundDeliverySnapshotToD1,
} from './inbound-delivery-authority.ts'
import { type MailboxInboundDeliverySnapshot } from './mailbox-inbound-ledger.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

function namespace(stub: object) {
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => stub,
	} as unknown as DurableObjectNamespace
}

test('dedupe claim precedes UserMeter, and insert failure replay does not double charge', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const userId = `user-${crypto.randomUUID()}`
	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'From: sender@example.com\r\n\r\nhello',
		quotaDay: '2026-08-02',
		now,
	})
	const snapshot: MailboxInboundDeliverySnapshot = {
		...delivery,
		provider: 'cloudflare-email-routing',
		state: 'pending',
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	const order: Array<string> = []
	let consumeCalls = 0
	let insertCalls = 0
	const meter = {
		async consumeInboundDelivery() {
			consumeCalls += 1
			order.push(`meter-${consumeCalls}`)
			return {
				outcome: 'ready' as const,
				count: 1,
				revision: 1,
				mirrorUpdatedAt: now.toISOString(),
				consumed: consumeCalls === 1,
				replayed: consumeCalls > 1,
				day: '2026-08-02',
				resource: 'email_receives_per_day' as const,
			}
		},
	}
	const mailbox = {
		getInboundDelivery: vi.fn(async () => null),
		claimInboundDeliveryWindow: vi.fn(async () => {
			order.push('mailbox-window')
			return snapshot
		}),
		insertChargedPendingInboundDelivery: vi.fn(async () => {
			insertCalls += 1
			order.push(`mailbox-${insertCalls}`)
			if (insertCalls === 1) throw new Error('injected Mailbox insert failure')
			return { status: 'inserted' as const, delivery: snapshot }
		}),
	}
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace(meter),
			MAILBOX: namespace(mailbox),
		},
		userId,
	})

	await expect(
		authority.charge({ delivery, plan: 'pro', limit: 100, now }),
	).rejects.toThrow('injected Mailbox insert failure')
	expect(order).toEqual(['mailbox-window', 'meter-1', 'mailbox-1'])

	const replay = await authority.charge({
		delivery,
		plan: 'pro',
		limit: 100,
		now,
	})
	expect(replay).toBe(delivery)
	expect(order).toEqual([
		'mailbox-window',
		'meter-1',
		'mailbox-1',
		'mailbox-window',
		'meter-2',
		'mailbox-2',
	])
	expect(consumeCalls).toBe(2)
	expect(insertCalls).toBe(2)
	expect(
		await db
			.prepare(
				`SELECT state, fingerprint FROM email_delivery_events
				WHERE id = ? AND user_id = ?`,
			)
			.bind(delivery.deliveryId, userId)
			.first(),
	).toEqual({ state: 'pending', fingerprint: delivery.fingerprint })
	sqlite.close()
})

test('dedupe boundary race charges and inserts only the claimed winner id', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const userId = `user-${crypto.randomUUID()}`
	const now = new Date('2026-08-02T12:00:00.000Z')
	const winner = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'From: sender@example.com\r\n\r\nsame message',
		quotaDay: '2026-08-02',
		now,
	})
	const loser: typeof winner = {
		...winner,
		deliveryId: `${winner.deliveryId}-boundary-loser`,
		messageId: `${winner.messageId}-boundary-loser`,
		rawMimeKey: `${winner.rawMimeKey}-boundary-loser`,
	}
	const winnerSnapshot: MailboxInboundDeliverySnapshot = {
		...winner,
		state: 'pending',
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	let stored: MailboxInboundDeliverySnapshot | null = null
	const consumedDeliveryIds: Array<string> = []
	const insertedDeliveryIds: Array<string> = []
	const meter = {
		consumeInboundDelivery: vi.fn(async (input: { deliveryId: string }) => {
			consumedDeliveryIds.push(input.deliveryId)
			return {
				outcome: 'ready' as const,
				count: 1,
				revision: 1,
				mirrorUpdatedAt: now.toISOString(),
				consumed: true,
				replayed: false,
				day: '2026-08-02',
				resource: 'email_receives_per_day' as const,
			}
		}),
	}
	const mailbox = {
		getInboundDelivery: vi.fn(async (input: { deliveryId: string }) =>
			stored?.deliveryId === input.deliveryId ? stored : null,
		),
		claimInboundDeliveryWindow: vi.fn(async () => winnerSnapshot),
		insertChargedPendingInboundDelivery: vi.fn(
			async (input: { delivery: { deliveryId: string } }) => {
				insertedDeliveryIds.push(input.delivery.deliveryId)
				stored = winnerSnapshot
				return { status: 'inserted' as const, delivery: winnerSnapshot }
			},
		),
	}
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace(meter),
			MAILBOX: namespace(mailbox),
		},
		userId,
	})

	const first = await authority.charge({
		delivery: winner,
		plan: 'pro',
		limit: 100,
		now,
	})
	const boundaryLoser = await authority.charge({
		delivery: loser,
		plan: 'pro',
		limit: 100,
		now,
	})

	expect(first).toBe(winner)
	expect(boundaryLoser.deliveryId).toBe(winner.deliveryId)
	expect(consumedDeliveryIds).toEqual([winner.deliveryId])
	expect(insertedDeliveryIds).toEqual([winner.deliveryId])
	expect(consumedDeliveryIds).not.toContain(loser.deliveryId)
	sqlite.close()
})

test('storage claim projection failure releases the authoritative Mailbox lease', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId: 'user-storage-owner',
		inboxId: 'inbox-storage',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'storage projection',
		quotaDay: '2026-08-02',
		now,
	})
	const claimed: MailboxInboundDeliverySnapshot = {
		...delivery,
		state: 'storing',
		storageLease: 'storage-lease-1',
		storageLeaseAt: now.toISOString(),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	await mirrorUserInboundDeliverySnapshotToD1({
		db,
		userId: 'different-owner',
		snapshot: claimed,
	})
	const releaseInboundDeliveryStorage = vi.fn(async () => ({
		status: 'released' as const,
		delivery: {
			...claimed,
			state: 'pending' as const,
			storageLease: undefined,
			storageLeaseAt: undefined,
		},
	}))
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace({}),
			MAILBOX: namespace({
				claimInboundDeliveryStorage: vi.fn(async () => ({
					status: 'claimed' as const,
					delivery: claimed,
				})),
				releaseInboundDeliveryStorage,
			}),
		},
		userId: delivery.userId,
	})

	await expect(
		authority.claimStorage(delivery, 2, now.toISOString(), now),
	).rejects.toThrow('owner/provider fence')
	expect(releaseInboundDeliveryStorage).toHaveBeenCalledWith({
		ownerId: delivery.userId,
		deliveryId: delivery.deliveryId,
		storageLease: 'storage-lease-1',
		now: now.toISOString(),
	})
	sqlite.close()
})

test('effect and cleanup claim projection failures warn without stranding leases', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	consoleWarn.mockImplementation(() => {})
	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId: 'user-claim-owner',
		inboxId: 'inbox-claim',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'claim projection',
		quotaDay: '2026-08-02',
		now,
	})
	const base: MailboxInboundDeliverySnapshot = {
		...delivery,
		state: 'received',
		finalizationToken: 'final-1',
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	await mirrorUserInboundDeliverySnapshotToD1({
		db,
		userId: 'different-owner',
		snapshot: base,
	})
	const cleanup = {
		...base,
		state: 'cleaning' as const,
		cleanupLease: 'cleanup-1',
		cleanupLeaseAt: now.toISOString(),
	}
	const usage = {
		...base,
		usageEffectLease: 'usage-1',
		usageEffectLeaseAt: now.toISOString(),
	}
	const subscription = {
		...base,
		subscriptionEffectState: 'processing' as const,
		subscriptionEffectLease: 'subscription-1',
		subscriptionEffectLeaseAt: now.toISOString(),
	}
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace({}),
			MAILBOX: namespace({
				claimInboundDeliveryCleanup: vi.fn(async () => ({
					status: 'claimed' as const,
					delivery: cleanup,
				})),
				claimInboundUsageEffect: vi.fn(async () => ({
					status: 'claimed' as const,
					delivery: usage,
				})),
				claimInboundSubscriptionEffect: vi.fn(async () => ({
					status: 'claimed' as const,
					delivery: subscription,
				})),
			}),
		},
		userId: delivery.userId,
	})

	await expect(
		authority.claimCleanup(delivery.deliveryId, now),
	).resolves.toMatchObject({ status: 'claimed' })
	await expect(
		authority.claimUsageEffect({ deliveryId: delivery.deliveryId, now }),
	).resolves.toMatchObject({ status: 'claimed' })
	await expect(
		authority.claimSubscriptionEffect({
			deliveryId: delivery.deliveryId,
			now,
		}),
	).resolves.toMatchObject({ status: 'claimed' })
	expect(consoleWarn).toHaveBeenCalledWith(
		'inbound-email-cleanup-claim-projection-failed',
		delivery.userId,
		delivery.deliveryId,
		expect.objectContaining({ message: expect.stringContaining('fence') }),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'inbound-email-usage-effect-claim-projection-failed',
		delivery.userId,
		delivery.deliveryId,
		expect.any(Error),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'inbound-email-subscription-effect-claim-projection-failed',
		delivery.userId,
		delivery.deliveryId,
		expect.any(Error),
	)
	sqlite.close()
})

test('full D1 snapshot mirror cannot cross an owner or provider fence', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId: 'owner-a',
		inboxId: 'inbox-a',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'hello',
		quotaDay: '2026-08-02',
		now,
	})
	const snapshot: MailboxInboundDeliverySnapshot = {
		...delivery,
		state: 'storing',
		storageLease: 'lease-a',
		storageLeaseAt: now.toISOString(),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	await mirrorUserInboundDeliverySnapshotToD1({
		db,
		userId: 'owner-a',
		snapshot,
	})
	await expect(
		mirrorUserInboundDeliverySnapshotToD1({
			db,
			userId: 'owner-b',
			snapshot: { ...snapshot, storageLease: 'lease-b' },
		}),
	).rejects.toThrow('owner/provider fence')
	expect(
		await db
			.prepare(
				`SELECT user_id, state, storage_lease FROM email_delivery_events
				WHERE id = ?`,
			)
			.bind(delivery.deliveryId)
			.first(),
	).toEqual({
		user_id: 'owner-a',
		state: 'storing',
		storage_lease: 'lease-a',
	})
	sqlite.close()
})

test('stale D1 mirrors fail closed without replacing a newer Mailbox snapshot', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const userId = `user-${crypto.randomUUID()}`
	const older = new Date('2026-08-02T12:00:00.000Z')
	const newer = new Date('2026-08-02T12:01:00.000Z')
	const delivery = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'hello',
		quotaDay: '2026-08-02',
		now: older,
	})
	const received: MailboxInboundDeliverySnapshot = {
		...delivery,
		state: 'received',
		finalizationToken: 'final-token',
		createdAt: older.toISOString(),
		updatedAt: newer.toISOString(),
	}
	await mirrorUserInboundDeliverySnapshotToD1({
		db,
		userId,
		snapshot: received,
	})
	await expect(
		mirrorUserInboundDeliverySnapshotToD1({
			db,
			userId,
			snapshot: {
				...received,
				state: 'storing',
				storageLease: 'stale-lease',
				storageLeaseAt: older.toISOString(),
				updatedAt: older.toISOString(),
			},
		}),
	).rejects.toThrow('owner/provider fence')
	expect(
		await db
			.prepare(
				`SELECT state, finalization_token, storage_lease
				FROM email_delivery_events WHERE id = ? AND user_id = ?`,
			)
			.bind(delivery.deliveryId, userId)
			.first(),
	).toEqual({
		state: 'received',
		finalization_token: 'final-token',
		storage_lease: null,
	})
	sqlite.close()
})

test('USER authority refuses the system email owner before bootstrap', () => {
	expect(() =>
		createUserInboundDeliveryAuthority({
			env: {} as Parameters<
				typeof createUserInboundDeliveryAuthority
			>[0]['env'],
			userId: 'system:email',
		}),
	).toThrow('must remain in D1')
})
