import { expect, test, vi } from 'vitest'
import { buildInboundDelivery } from './inbound-delivery.ts'
import { createUserInboundDeliveryAuthority } from './inbound-delivery-authority.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { type MailboxInboundDeliverySnapshot } from './mailbox-inbound-ledger.ts'

function namespace(stub: object) {
	return {
		idFromName: () => ({}) as DurableObjectId,
		get: () => stub,
	} as unknown as DurableObjectNamespace
}

async function createDelivery(userId: string, now: Date) {
	return await buildInboundDelivery({
		userId,
		inboxId: 'inbox-1',
		recipient: 'owner@example.com',
		envelopeFrom: 'sender@example.com',
		rawMime: 'From: sender@example.com\r\n\r\nhello',
		quotaDay: '2026-08-02',
		now,
	})
}

test('dedupe claim precedes UserMeter and a Mailbox retry does not prepare USER graph SQL', async () => {
	const userId = 'user-1'
	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = await createDelivery(userId, now)
	const snapshot: MailboxInboundDeliverySnapshot = {
		...delivery,
		state: 'pending',
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	}
	const order: Array<string> = []
	let consumeCalls = 0
	let insertCalls = 0
	const meter = {
		consumeInboundDelivery: vi.fn(async () => {
			consumeCalls += 1
			order.push(`meter-${consumeCalls}`)
			return {
				outcome: 'ready' as const,
				count: 1,
				revision: consumeCalls,
				mirrorUpdatedAt: now.toISOString(),
				consumed: consumeCalls === 1,
				replayed: consumeCalls > 1,
				day: delivery.quotaDay,
				resource: 'email_receives_per_day' as const,
			}
		}),
	}
	const mailbox = {
		getInboundDelivery: vi.fn(async () => null),
		getInboundDueWorkHint: vi.fn(async () => {
			order.push('mailbox-hint')
			return { dueAt: delivery.dedupeExpiresAt }
		}),
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
	const run = vi.fn(async () => {
		order.push('d1-hint')
		return { success: true }
	})
	const prepare = vi.fn(() => ({
		bind: vi.fn(() => ({ run })),
	}))
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: { prepare } as unknown as D1Database,
			USER_METER: namespace(meter),
			MAILBOX: namespace(mailbox),
		},
		userId,
	})

	await expect(
		authority.charge({ delivery, plan: 'pro', limit: 100, now }),
	).rejects.toThrow('injected Mailbox insert failure')
	await expect(
		authority.charge({ delivery, plan: 'pro', limit: 100, now }),
	).resolves.toEqual({ delivery, charged: true })

	expect(order).toEqual([
		'mailbox-window',
		'meter-1',
		'mailbox-1',
		'mailbox-window',
		'meter-2',
		'mailbox-2',
		'mailbox-hint',
		'd1-hint',
	])
	const statements = prepare.mock.calls.map(([sql]) => String(sql))
	expect(statements).toHaveLength(1)
	expect(statements[0]).toContain('email_inbound_due_owners')
	expect(statements[0]).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
})

test('commitInboundMessageGraph forwards the active storage lease to one owner Mailbox RPC', async () => {
	const userId = 'user-2'
	const now = new Date('2026-08-02T12:00:00.000Z')
	const delivery = {
		...(await createDelivery(userId, now)),
		state: 'storing' as const,
		storageLease: 'lease-1',
	}
	const commitInboundMessageGraph = vi.fn(async () => ({
		status: 'committed' as const,
		message: { id: delivery.messageId },
	}))
	const prepare = vi.fn()
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: { prepare } as unknown as D1Database,
			USER_METER: namespace({}),
			MAILBOX: namespace({ commitInboundMessageGraph }),
		},
		userId,
	})
	const thread = { id: delivery.threadId } as never
	const message = { id: delivery.messageId, direction: 'inbound' } as never
	const attachments = [{ id: 'attachment-1' }] as never

	await authority.commitInboundMessageGraph({
		delivery,
		thread,
		message,
		attachments,
	})

	expect(commitInboundMessageGraph).toHaveBeenCalledWith({
		ownerId: userId,
		deliveryId: delivery.deliveryId,
		storageLease: 'lease-1',
		thread,
		message,
		attachments,
	})
	expect(prepare).not.toHaveBeenCalled()
})

test('commitInboundMessageGraph rejects a delivery without an active lease', async () => {
	const userId = 'user-3'
	const now = new Date('2026-08-02T12:00:00.000Z')
	const authority = createUserInboundDeliveryAuthority({
		env: {
			APP_DB: {} as D1Database,
			USER_METER: namespace({}),
			MAILBOX: namespace({}),
		},
		userId,
	})

	await expect(
		authority.commitInboundMessageGraph({
			delivery: await createDelivery(userId, now),
			thread: {} as never,
			message: {} as never,
			attachments: [],
		}),
	).rejects.toThrow('active storage lease')
})

test('USER authority refuses the dedicated system email owner', () => {
	expect(() =>
		createUserInboundDeliveryAuthority({
			env: {
				APP_DB: {} as D1Database,
				USER_METER: namespace({}),
				MAILBOX: namespace({}),
			},
			userId: systemEmailOwnerId,
		}),
	).toThrow('must remain in D1')
})
