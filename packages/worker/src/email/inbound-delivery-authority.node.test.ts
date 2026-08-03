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
import { claimSystemInboundDeliveryWindow } from './system-inbound-delivery-authority.ts'
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
	expect(replay).toEqual({ delivery, charged: true })
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

	expect(first).toEqual({ delivery: winner, charged: true })
	expect(boundaryLoser.delivery.deliveryId).toBe(winner.deliveryId)
	expect(boundaryLoser.charged).toBe(false)
	expect(consumedDeliveryIds).toEqual([winner.deliveryId])
	expect(insertedDeliveryIds).toEqual([winner.deliveryId])
	expect(consumedDeliveryIds).not.toContain(loser.deliveryId)
	sqlite.close()
})

test("uncharged prior-day dedupe winner charges the current retry's quota day", async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const userId = `user-${crypto.randomUUID()}`
	const yesterday = new Date('2026-08-01T23:59:00.000Z')
	const retryNow = new Date('2026-08-02T00:01:00.000Z')
	const winner = await buildInboundDelivery({
		userId,
		inboxId: `inbox-${crypto.randomUUID()}`,
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'From: sender@example.com\r\n\r\nmidnight retry',
		quotaDay: '2026-08-01',
		now: yesterday,
	})
	const retry = { ...winner, quotaDay: '2026-08-02' }
	const winnerSnapshot: MailboxInboundDeliverySnapshot = {
		...winner,
		state: 'pending',
		createdAt: yesterday.toISOString(),
		updatedAt: retryNow.toISOString(),
	}
	const consumeInboundDelivery = vi.fn(
		async (input: { deliveryId: string; day: string }) => ({
			outcome: 'ready' as const,
			count: 1,
			revision: 1,
			mirrorUpdatedAt: retryNow.toISOString(),
			consumed: true,
			replayed: false,
			day: input.day,
			resource: 'email_receives_per_day' as const,
		}),
	)
	const insertChargedPendingInboundDelivery = vi.fn(
		async (input: {
			delivery: {
				deliveryId: string
				messageId: string
				rawMimeKey: string
				quotaDay: string
			}
		}) => ({
			status: 'inserted' as const,
			delivery: {
				...winnerSnapshot,
				quotaDay: input.delivery.quotaDay,
			},
		}),
	)
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace({ consumeInboundDelivery }),
			MAILBOX: namespace({
				getInboundDelivery: vi.fn(async () => null),
				claimInboundDeliveryWindow: vi.fn(async () => winnerSnapshot),
				insertChargedPendingInboundDelivery,
			}),
		},
		userId,
	})

	const result = await authority.charge({
		delivery: retry,
		plan: 'pro',
		limit: 100,
		now: retryNow,
	})

	expect(result.delivery).toEqual(retry)
	expect(result.charged).toBe(true)
	expect(consumeInboundDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			deliveryId: winner.deliveryId,
			day: '2026-08-02',
		}),
	)
	expect(insertChargedPendingInboundDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			delivery: expect.objectContaining({
				deliveryId: winner.deliveryId,
				messageId: winner.messageId,
				rawMimeKey: winner.rawMimeKey,
				quotaDay: '2026-08-02',
			}),
		}),
	)
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

test('cleanup projection failure releases its lease and prevents deletion work', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
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
	const cleanup: MailboxInboundDeliverySnapshot = {
		...delivery,
		state: 'cleaning',
		cleanupLease: 'cleanup-1',
		cleanupLeaseAt: now.toISOString(),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	await mirrorUserInboundDeliverySnapshotToD1({
		db,
		userId: 'different-owner',
		snapshot: cleanup,
	})
	const releaseInboundDeliveryCleanup = vi.fn(async () => ({
		status: 'released' as const,
		delivery: {
			...cleanup,
			state: 'pending' as const,
			cleanupLease: undefined,
			cleanupLeaseAt: undefined,
		},
	}))
	const deleteBlob = vi.fn(async () => {})
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace({}),
			MAILBOX: namespace({
				claimInboundDeliveryCleanup: vi.fn(async () => ({
					status: 'claimed' as const,
					delivery: cleanup,
				})),
				releaseInboundDeliveryCleanup,
			}),
		},
		userId: delivery.userId,
	})

	await expect(
		authority
			.claimCleanup({
				deliveryId: delivery.deliveryId,
				expectedState: delivery.state,
				expectedUpdatedAt: cleanup.updatedAt,
				staleBefore: new Date(now.getTime() - 1),
				now,
			})
			.then(async () => await deleteBlob()),
	).rejects.toThrow('owner/provider fence')
	expect(deleteBlob).not.toHaveBeenCalled()
	expect(releaseInboundDeliveryCleanup).toHaveBeenCalledWith({
		ownerId: delivery.userId,
		deliveryId: delivery.deliveryId,
		cleanupLease: 'cleanup-1',
		now: now.toISOString(),
	})
	sqlite.close()
})

test('cleanup projection and compensation failures surface as AggregateError', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId: 'user-cleanup-compensation-owner',
		inboxId: 'inbox-cleanup-compensation',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'cleanup compensation',
		quotaDay: '2026-08-02',
		now,
	})
	const cleanup: MailboxInboundDeliverySnapshot = {
		...delivery,
		state: 'cleaning',
		cleanupLease: 'cleanup-compensation-lease',
		cleanupLeaseAt: now.toISOString(),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	await mirrorUserInboundDeliverySnapshotToD1({
		db,
		userId: 'different-owner',
		snapshot: cleanup,
	})
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace({}),
			MAILBOX: namespace({
				claimInboundDeliveryCleanup: vi.fn(async () => ({
					status: 'claimed' as const,
					delivery: cleanup,
				})),
				releaseInboundDeliveryCleanup: vi.fn(async () => {
					throw new Error('cleanup release unavailable')
				}),
			}),
		},
		userId: delivery.userId,
	})

	const error = await authority
		.claimCleanup({
			deliveryId: delivery.deliveryId,
			expectedState: delivery.state,
			expectedUpdatedAt: cleanup.updatedAt,
			staleBefore: new Date(now.getTime() - 1),
			now,
		})
		.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AggregateError)
	expect(error).toMatchObject({
		message:
			'Inbound cleanup claim projection failed and its Mailbox lease could not be released.',
		errors: [
			expect.objectContaining({ message: expect.stringContaining('fence') }),
			expect.objectContaining({ message: 'cleanup release unavailable' }),
		],
	})
	sqlite.close()
})

test('effect claim projection failures warn without stranding leases', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	consoleWarn.mockImplementation(() => {})
	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId: 'user-effect-claim-owner',
		inboxId: 'inbox-effect-claim',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'effect claim projection',
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
		authority.claimUsageEffect({ deliveryId: delivery.deliveryId, now }),
	).resolves.toMatchObject({ status: 'claimed' })
	await expect(
		authority.claimSubscriptionEffect({
			deliveryId: delivery.deliveryId,
			now,
		}),
	).resolves.toMatchObject({ status: 'claimed' })
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

test('stale D1 mirrors are safe no-ops without replacing a newer snapshot', async () => {
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
	).resolves.toEqual({ status: 'stale' })
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

test('bootstrap skips malformed and cross-owner legacy D1 rows', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	consoleWarn.mockImplementation(() => {})
	const ownerId = `owner-${crypto.randomUUID()}`
	const now = new Date('2026-08-02T12:00:00.000Z')
	const crossOwner = await buildInboundDelivery({
		userId: `other-${crypto.randomUUID()}`,
		inboxId: 'inbox-cross-owner',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'cross owner',
		quotaDay: '2026-08-02',
		now,
	})
	const malformedId = `malformed-${crypto.randomUUID()}`
	for (const [id, detailJson] of [
		[crossOwner.deliveryId, JSON.stringify(crossOwner)],
		[malformedId, '{'],
	] as const) {
		await db
			.prepare(
				`INSERT INTO email_delivery_events (
					id, user_id, event_type, provider, provider_event_id,
					detail_json, created_at
				) VALUES (?, ?, 'receive_started', 'cloudflare-email-routing', ?, ?, ?)`,
			)
			.bind(id, ownerId, id, detailJson, now.toISOString())
			.run()
	}
	const upsertDeliveryEvent = vi.fn()
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace({}),
			MAILBOX: namespace({
				getInboundDelivery: vi.fn(async () => null),
				upsertDeliveryEvent,
			}),
		},
		userId: ownerId,
	})

	await expect(authority.get(crossOwner.deliveryId)).resolves.toBeNull()
	await expect(authority.get(malformedId)).resolves.toBeNull()
	expect(upsertDeliveryEvent).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'inbound-email-delivery-bootstrap-row-invalid',
		ownerId,
		crossOwner.deliveryId,
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'inbound-email-delivery-bootstrap-row-invalid',
		ownerId,
		malformedId,
	)
	sqlite.close()
})

test('dedupe prune projects only the exact Mailbox IDs with owner/provider fences', async () => {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	const ownerId = 'owner-prune'
	const selectedId = 'email-inbound-dedupe:selected'
	const unselectedId = 'email-inbound-dedupe:unselected'
	const foreignId = 'email-inbound-dedupe:foreign'
	const wrongProviderId = 'email-inbound-dedupe:wrong-provider'
	const now = new Date('2026-08-02T12:00:00.000Z')
	for (const [id, userId, provider] of [
		[selectedId, ownerId, 'cloudflare-email-routing-dedupe'],
		[unselectedId, ownerId, 'cloudflare-email-routing-dedupe'],
		[foreignId, 'other-owner', 'cloudflare-email-routing-dedupe'],
		[wrongProviderId, ownerId, 'cloudflare-email-routing'],
	] as const) {
		await db
			.prepare(
				`INSERT INTO email_delivery_events (
					id, user_id, event_type, provider, created_at, updated_at
				) VALUES (?, ?, 'receive_started', ?, ?, ?)`,
			)
			.bind(id, userId, provider, now.toISOString(), now.toISOString())
			.run()
	}
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: db,
			USER_METER: namespace({}),
			MAILBOX: namespace({
				pruneExpiredInboundDedupePointers: vi.fn(async () => ({
					pruned: 3,
					prunedEventIds: [selectedId, foreignId, wrongProviderId],
				})),
			}),
		},
		userId: ownerId,
	})

	expect(await authority.pruneExpiredDedupe(now, 10)).toBe(3)
	const remaining = await db
		.prepare(
			`SELECT id FROM email_delivery_events
			ORDER BY id`,
		)
		.all<{ id: string }>()
	expect(remaining.results?.map((row) => row.id)).toEqual([
		foreignId,
		unselectedId,
		wrongProviderId,
	])
	sqlite.close()

	const prepare = vi.fn()
	const emptyAuthority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: { prepare } as unknown as D1Database,
			USER_METER: namespace({}),
			MAILBOX: namespace({
				pruneExpiredInboundDedupePointers: vi.fn(async () => ({
					pruned: 0,
					prunedEventIds: [],
				})),
			}),
		},
		userId: 'owner-empty-prune',
	})
	expect(await emptyAuthority.pruneExpiredDedupe()).toBe(0)
	expect(prepare).not.toHaveBeenCalled()
})

test('USER and system inbound authority surfaces refuse the wrong owner', async () => {
	expect(() =>
		createUserInboundDeliveryAuthority({
			env: {} as Parameters<
				typeof createUserInboundDeliveryAuthority
			>[0]['env'],
			userId: 'system:email',
		}),
	).toThrow('must remain in D1')

	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = await buildInboundDelivery({
		userId: 'user-cannot-use-system-d1',
		inboxId: 'inbox-system-fence',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'system fence',
		quotaDay: '2026-08-02',
		now,
	})
	await expect(
		claimSystemInboundDeliveryWindow({
			db: {} as D1Database,
			delivery,
			now,
		}),
	).rejects.toThrow('restricted to system:email')
})
