import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { buildInboundDelivery } from './inbound-delivery.ts'
import {
	createUserInboundDeliveryAuthority,
	mirrorUserInboundDeliverySnapshotToD1,
} from './inbound-delivery-authority.ts'
import { type MailboxInboundDeliverySnapshot } from './mailbox-inbound-ledger.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('UserMeter charge precedes Mailbox insert failure and replay does not charge twice', async () => {
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
	const namespace = (stub: object) =>
		({
			idFromName: () => ({}) as DurableObjectId,
			get: () => stub,
		}) as unknown as DurableObjectNamespace
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
	expect(order).toEqual(['meter-1', 'mailbox-window', 'mailbox-1'])

	const replay = await authority.charge({
		delivery,
		plan: 'pro',
		limit: 100,
		now,
	})
	expect(replay).toBe(delivery)
	expect(order).toEqual([
		'meter-1',
		'mailbox-window',
		'mailbox-1',
		'meter-2',
		'mailbox-window',
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
