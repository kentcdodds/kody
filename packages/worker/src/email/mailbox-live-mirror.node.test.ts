import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { mailboxMirrorRpcTimeoutMs } from './mailbox-mirror.ts'
import {
	mailboxLiveMirrorMaxAnalyticsWrites,
	mailboxLiveMirrorMaxEvents,
	mirrorMailboxDeliveryEventFromD1,
	mirrorMailboxMessageGraphFromD1,
} from './mailbox-live-mirror.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import { type EmailThreadRecord } from './types.ts'

async function createEmailDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureEmailTestSchema(db)
	return { sqlite, db }
}

function fakeMailboxEnv(stub: Record<string, unknown>) {
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const get = vi.fn(() => stub)
	const writeDataPoint = vi.fn()
	return {
		env: {
			MAILBOX: {
				idFromName,
				get,
			} as unknown as DurableObjectNamespace,
			EMAIL_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		writeDataPoint,
	}
}

async function seedMessage(db: D1Database) {
	const at = '2026-07-01T12:00:00.000Z'
	await db
		.prepare(
			`INSERT INTO email_threads (
				id, user_id, inbox_id, subject_normalized, root_message_id_header,
				last_message_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			'thread-1',
			'user-aaa',
			'inbox-1',
			'hello',
			'<root@example.com>',
			at,
			at,
			at,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, inbox_id, thread_id, from_address,
				to_addresses_json, subject, raw_mime_key, raw_size,
				processing_status, classification, received_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			'msg-1',
			'outbound',
			'user-aaa',
			'inbox-1',
			'thread-1',
			'sender@example.com',
			'["owner@example.com"]',
			'Hello',
			null,
			0,
			'sent',
			'accepted',
			null,
			at,
			at,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO email_attachments (
				id, message_id, filename, content_type, size, storage_kind, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind('att-1', 'msg-1', 'note.txt', 'text/plain', 4, 'unavailable', at)
		.run()
}

async function seedDeliveryEvent(
	db: D1Database,
	input: { id: string; eventType: string; createdAt: string },
) {
	await db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, inbox_id, event_type, provider,
				provider_message_id, provider_event_id, detail_json,
				needs_effect_reconcile, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			'msg-1',
			'user-aaa',
			'inbox-1',
			input.eventType,
			'kody',
			null,
			null,
			'{}',
			0,
			input.createdAt,
		)
		.run()
}

async function seedMessageGraph(db: D1Database) {
	await seedMessage(db)
	await seedDeliveryEvent(db, {
		id: 'evt-1',
		eventType: 'send_requested',
		createdAt: '2026-07-01T12:00:01.000Z',
	})
	await seedDeliveryEvent(db, {
		id: 'evt-2',
		eventType: 'sent',
		createdAt: '2026-07-01T12:00:02.000Z',
	})
}

test('live-mirror AE write budget stays under Analytics Engine request cap', () => {
	expect(mailboxLiveMirrorMaxAnalyticsWrites).toBeLessThan(250)
	expect(mailboxLiveMirrorMaxAnalyticsWrites).toBe(
		1 + mailboxLiveMirrorMaxEvents,
	)
})

test('live-mirror graph mirrors message before events and uses createdAt for event updatedAt', async () => {
	const { db } = await createEmailDb()
	await seedMessageGraph(db)

	let messageSettled = false
	const mirrorMessage = vi.fn(async () => {
		messageSettled = true
		return { ok: true as const, accepted: true }
	})
	const upsertDeliveryEvent = vi.fn(
		async (input: { event: { id: string } }) => {
			expect(messageSettled).toBe(true)
			return {
				inserted: true,
				accepted: true,
				updatedLatestStatus: false,
				eventId: input.event.id,
			}
		},
	)
	const { env } = fakeMailboxEnv({ mirrorMessage, upsertDeliveryEvent })

	const thread: EmailThreadRecord = {
		id: 'thread-1',
		userId: 'user-aaa',
		inboxId: 'inbox-1',
		subjectNormalized: 'hello',
		rootMessageIdHeader: '<root@example.com>',
		lastMessageAt: '2026-07-01T12:00:00.000Z',
		createdAt: '2026-07-01T12:00:00.000Z',
		updatedAt: '2026-07-01T12:00:00.000Z',
	}

	const summary = await mirrorMailboxMessageGraphFromD1({
		env,
		db,
		userId: 'user-aaa',
		messageId: 'msg-1',
		sourceMutationAt: '2026-07-01T12:00:03.000Z',
		thread,
	})

	expect(summary).toEqual({
		messageId: 'msg-1',
		message: { status: 'mirrored' },
		events: [
			{ eventId: 'evt-1', result: { status: 'mirrored' } },
			{ eventId: 'evt-2', result: { status: 'mirrored' } },
		],
		eventsTruncated: false,
	})
	expect(mirrorMessage).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: 'user-aaa',
			thread: expect.objectContaining({ id: 'thread-1' }),
			message: expect.objectContaining({ id: 'msg-1' }),
			attachments: [
				expect.objectContaining({ id: 'att-1', filename: 'note.txt' }),
			],
		}),
	)

	// When thread is omitted, load it from D1 via getEmailThreadById.
	mirrorMessage.mockClear()
	upsertDeliveryEvent.mockClear()
	await mirrorMailboxMessageGraphFromD1({
		env,
		db,
		userId: 'user-aaa',
		messageId: 'msg-1',
	})
	expect(mirrorMessage).toHaveBeenCalledWith(
		expect.objectContaining({
			thread: expect.objectContaining({
				id: 'thread-1',
				subjectNormalized: 'hello',
			}),
		}),
	)
	expect(upsertDeliveryEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			event: expect.objectContaining({
				id: 'evt-1',
				createdAt: '2026-07-01T12:00:01.000Z',
				updatedAt: '2026-07-01T12:00:01.000Z',
			}),
		}),
	)
	expect(upsertDeliveryEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			event: expect.objectContaining({
				id: 'evt-2',
				createdAt: '2026-07-01T12:00:02.000Z',
				updatedAt: '2026-07-01T12:00:02.000Z',
			}),
		}),
	)
})

test('live-mirror graph fans out event RPCs concurrently after message settles', async () => {
	vi.useFakeTimers()
	try {
		const { db } = await createEmailDb()
		await seedMessage(db)
		const eventCount = 5
		for (let index = 0; index < eventCount; index += 1) {
			await seedDeliveryEvent(db, {
				id: `evt-${index + 1}`,
				eventType: index === 0 ? 'send_requested' : 'sent',
				createdAt: `2026-07-01T12:00:0${index + 1}.000Z`,
			})
		}

		const eventDelayMs = 400
		let maxInFlight = 0
		let inFlight = 0
		let messageSettled = false
		const mirrorMessage = vi.fn(async () => {
			messageSettled = true
			return { ok: true as const, accepted: true }
		})
		const upsertDeliveryEvent = vi.fn(async () => {
			expect(messageSettled).toBe(true)
			inFlight += 1
			maxInFlight = Math.max(maxInFlight, inFlight)
			await new Promise<void>((resolve) => {
				setTimeout(resolve, eventDelayMs)
			})
			inFlight -= 1
			return { inserted: true, accepted: true, updatedLatestStatus: false }
		})
		const { env } = fakeMailboxEnv({ mirrorMessage, upsertDeliveryEvent })

		const pending = mirrorMailboxMessageGraphFromD1({
			env,
			db,
			userId: 'user-aaa',
			messageId: 'msg-1',
		})

		// One event-delay tick completes the whole fan-out (not eventCount × delay).
		await vi.advanceTimersByTimeAsync(eventDelayMs)
		const summary = await pending

		expect(summary.events).toHaveLength(eventCount)
		expect(summary.eventsTruncated).toBe(false)
		expect(maxInFlight).toBe(eventCount)
		expect(upsertDeliveryEvent).toHaveBeenCalledTimes(eventCount)
		// Wall budget stays near one RPC timeout for the event phase.
		expect(eventDelayMs).toBeLessThan(mailboxMirrorRpcTimeoutMs)
	} finally {
		vi.useRealTimers()
	}
})

test('live-mirror graph sets eventsTruncated and mirrors at most max events', async () => {
	const { db } = await createEmailDb()
	await seedMessage(db)

	const totalEvents = mailboxLiveMirrorMaxEvents + 1
	const baseMs = Date.parse('2026-07-01T12:00:00.000Z')
	for (let index = 0; index < totalEvents; index += 1) {
		const id = `evt-${String(index).padStart(3, '0')}`
		await seedDeliveryEvent(db, {
			id,
			eventType: index === 0 ? 'send_requested' : 'sent',
			createdAt: new Date(baseMs + index * 1000).toISOString(),
		})
	}

	const upsertDeliveryEvent = vi.fn(async () => ({
		inserted: true,
		accepted: true,
		updatedLatestStatus: false,
	}))
	const mirrorMessage = vi.fn(async () => ({
		ok: true as const,
		accepted: true,
	}))
	const { env, writeDataPoint } = fakeMailboxEnv({
		mirrorMessage,
		upsertDeliveryEvent,
	})

	const summary = await mirrorMailboxMessageGraphFromD1({
		env,
		db,
		userId: 'user-aaa',
		messageId: 'msg-1',
	})

	expect(summary.eventsTruncated).toBe(true)
	expect(summary.events).toHaveLength(mailboxLiveMirrorMaxEvents)
	expect(summary.events[0]?.eventId).toBe('evt-000')
	expect(summary.events.at(-1)?.eventId).toBe(
		`evt-${String(mailboxLiveMirrorMaxEvents - 1).padStart(3, '0')}`,
	)
	expect(upsertDeliveryEvent).toHaveBeenCalledTimes(mailboxLiveMirrorMaxEvents)
	// 1 message + max events AE writes; never the overflow row.
	expect(writeDataPoint).toHaveBeenCalledTimes(
		mailboxLiveMirrorMaxAnalyticsWrites,
	)
	expect(writeDataPoint.mock.calls.length).toBeLessThan(250)
})

test('live-mirror graph returns missing when D1 message is absent', async () => {
	const { db } = await createEmailDb()
	const mirrorMessage = vi.fn(async () => ({
		ok: true as const,
		accepted: true,
	}))
	const { env } = fakeMailboxEnv({ mirrorMessage })

	await expect(
		mirrorMailboxMessageGraphFromD1({
			env,
			db,
			userId: 'user-aaa',
			messageId: 'missing-msg',
		}),
	).resolves.toEqual({
		messageId: 'missing-msg',
		message: { status: 'missing' },
		events: [],
		eventsTruncated: false,
	})
	expect(mirrorMessage).not.toHaveBeenCalled()
})

test('live-mirror graph catches unexpected errors without throwing', async () => {
	consoleWarn.mockImplementation(() => {})
	const mirrorMessage = vi.fn(async () => ({
		ok: true as const,
		accepted: true,
	}))
	const { env } = fakeMailboxEnv({ mirrorMessage })
	const db = {
		prepare() {
			throw new Error('d1 exploded')
		},
	} as unknown as D1Database

	await expect(
		mirrorMailboxMessageGraphFromD1({
			env,
			db,
			userId: 'user-aaa',
			messageId: 'msg-1',
		}),
	).resolves.toEqual({
		messageId: 'msg-1',
		message: {
			status: 'error',
			error: expect.objectContaining({ message: 'd1 exploded' }),
		},
		events: [],
		eventsTruncated: false,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'mailbox-live-mirror-message-graph-failed',
		expect.objectContaining({ message: 'd1 exploded' }),
	)
})

test('live-mirror one-event helper loads cohesive projection and returns missing', async () => {
	const { db } = await createEmailDb()
	await seedMessageGraph(db)

	const upsertDeliveryEvent = vi.fn(async () => ({
		inserted: true,
		accepted: true,
		updatedLatestStatus: false,
	}))
	const { env } = fakeMailboxEnv({ upsertDeliveryEvent })

	expect(
		await mirrorMailboxDeliveryEventFromD1({
			env,
			db,
			userId: 'user-aaa',
			eventId: 'evt-2',
		}),
	).toEqual({ status: 'mirrored' })
	expect(upsertDeliveryEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			event: expect.objectContaining({
				id: 'evt-2',
				updatedAt: '2026-07-01T12:00:02.000Z',
			}),
		}),
	)

	expect(
		await mirrorMailboxDeliveryEventFromD1({
			env,
			db,
			userId: 'user-aaa',
			eventId: 'missing-evt',
		}),
	).toEqual({ status: 'missing' })
})
