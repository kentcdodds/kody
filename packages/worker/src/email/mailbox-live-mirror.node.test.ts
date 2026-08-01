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
import { type MailboxDeliveryEventInput } from './mailbox-types.ts'

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

test('live-mirror AE write budget is at most two writes per graph attempt', () => {
	expect(mailboxLiveMirrorMaxAnalyticsWrites).toBe(2)
	expect(mailboxLiveMirrorMaxAnalyticsWrites).toBeLessThan(250)
})

test('live-mirror graph mirrors message before one batch event RPC and uses createdAt for event updatedAt', async () => {
	const { db } = await createEmailDb()
	await seedMessageGraph(db)

	let messageSettled = false
	const mirrorMessage = vi.fn(async () => {
		messageSettled = true
		return { ok: true as const, accepted: true }
	})
	const upsertDeliveryEvents = vi.fn(
		async (input: { events: Array<{ id: string }> }) => {
			expect(messageSettled).toBe(true)
			return {
				results: input.events.map((event) => ({
					eventId: event.id,
					inserted: true,
					accepted: true,
				})),
			}
		},
	)
	const upsertDeliveryEvent = vi.fn(async () => ({
		inserted: true,
		accepted: true,
		updatedLatestStatus: false,
	}))
	const { env } = fakeMailboxEnv({
		mirrorMessage,
		upsertDeliveryEvents,
		upsertDeliveryEvent,
	})

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
	expect(upsertDeliveryEvents).toHaveBeenCalledTimes(1)
	expect(upsertDeliveryEvent).not.toHaveBeenCalled()

	// When thread is omitted, load it from D1 via getEmailThreadById.
	mirrorMessage.mockClear()
	upsertDeliveryEvents.mockClear()
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
	expect(upsertDeliveryEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: 'user-aaa',
			events: [
				expect.objectContaining({
					id: 'evt-1',
					createdAt: '2026-07-01T12:00:01.000Z',
					updatedAt: '2026-07-01T12:00:01.000Z',
				}),
				expect.objectContaining({
					id: 'evt-2',
					createdAt: '2026-07-01T12:00:02.000Z',
					updatedAt: '2026-07-01T12:00:02.000Z',
				}),
			],
		}),
	)
})

test('live-mirror graph uses one batch RPC after message settles, not per-event fan-out', async () => {
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

		const batchDelayMs = 400
		let messageSettled = false
		let batchCalls = 0
		const mirrorMessage = vi.fn(async () => {
			messageSettled = true
			return { ok: true as const, accepted: true }
		})
		const upsertDeliveryEvents = vi.fn(
			async (input: { events: Array<{ id: string }> }) => {
				expect(messageSettled).toBe(true)
				batchCalls += 1
				await new Promise<void>((resolve) => {
					setTimeout(resolve, batchDelayMs)
				})
				return {
					results: input.events.map((event) => ({
						eventId: event.id,
						inserted: true,
						accepted: true,
					})),
				}
			},
		)
		const upsertDeliveryEvent = vi.fn()
		const { env } = fakeMailboxEnv({
			mirrorMessage,
			upsertDeliveryEvents,
			upsertDeliveryEvent,
		})

		const pending = mirrorMailboxMessageGraphFromD1({
			env,
			db,
			userId: 'user-aaa',
			messageId: 'msg-1',
		})

		await vi.advanceTimersByTimeAsync(batchDelayMs)
		const summary = await pending

		expect(summary.events).toHaveLength(eventCount)
		expect(summary.eventsTruncated).toBe(false)
		expect(batchCalls).toBe(1)
		expect(upsertDeliveryEvents).toHaveBeenCalledTimes(1)
		expect(upsertDeliveryEvent).not.toHaveBeenCalled()
		expect(batchDelayMs).toBeLessThan(mailboxMirrorRpcTimeoutMs)
	} finally {
		vi.useRealTimers()
	}
})

test('live-mirror graph keeps newest events when truncated and sets eventsTruncated', async () => {
	consoleWarn.mockImplementation(() => {})
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

	const upsertDeliveryEvents = vi.fn(
		async (input: { events: Array<MailboxDeliveryEventInput> }) => ({
			results: input.events.map((event) => ({
				eventId: event.id,
				inserted: true,
				accepted: true,
			})),
		}),
	)
	const mirrorMessage = vi.fn(async () => ({
		ok: true as const,
		accepted: true,
	}))
	const { env, writeDataPoint } = fakeMailboxEnv({
		mirrorMessage,
		upsertDeliveryEvents,
	})

	const summary = await mirrorMailboxMessageGraphFromD1({
		env,
		db,
		userId: 'user-aaa',
		messageId: 'msg-1',
	})

	expect(summary.eventsTruncated).toBe(true)
	expect(summary.events).toHaveLength(mailboxLiveMirrorMaxEvents)
	// Newest max kept: drop oldest overflow evt-000.
	expect(summary.events[0]?.eventId).toBe('evt-001')
	expect(summary.events.at(-1)?.eventId).toBe(
		`evt-${String(mailboxLiveMirrorMaxEvents).padStart(3, '0')}`,
	)
	expect(upsertDeliveryEvents).toHaveBeenCalledTimes(1)
	const batchEvents = upsertDeliveryEvents.mock.calls[0]?.[0]?.events ?? []
	expect(batchEvents).toHaveLength(mailboxLiveMirrorMaxEvents)
	expect(batchEvents[0]?.id).toBe('evt-001')
	expect(batchEvents.at(-1)?.id).toBe(
		`evt-${String(mailboxLiveMirrorMaxEvents).padStart(3, '0')}`,
	)
	// At most two AE writes: message + batch; never per-event fan-out.
	expect(writeDataPoint).toHaveBeenCalledTimes(
		mailboxLiveMirrorMaxAnalyticsWrites,
	)
	expect(writeDataPoint.mock.calls.length).toBeLessThan(250)
	expect(
		writeDataPoint.mock.calls.some(
			(call) =>
				(call[0] as { blobs: Array<string> }).blobs[0] ===
				'mailbox_mirror:upsert_delivery_event_batch',
		),
	).toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(
		'mailbox-live-mirror-events-truncated',
		{
			userId: 'user-aaa',
			messageId: 'msg-1',
			loaded: totalEvents,
			max: mailboxLiveMirrorMaxEvents,
		},
	)
})

test('live-mirror graph maps batch timeout and error onto each event summary', async () => {
	vi.useFakeTimers()
	consoleWarn.mockImplementation(() => {})
	try {
		const { db } = await createEmailDb()
		await seedMessageGraph(db)

		const mirrorMessage = vi.fn(async () => ({
			ok: true as const,
			accepted: true,
		}))
		const hangBatch = vi.fn(() => new Promise<never>(() => {}))
		const { env: hangEnv, writeDataPoint: hangWrite } = fakeMailboxEnv({
			mirrorMessage,
			upsertDeliveryEvents: hangBatch,
		})

		const pendingTimeout = mirrorMailboxMessageGraphFromD1({
			env: hangEnv,
			db,
			userId: 'user-aaa',
			messageId: 'msg-1',
		})
		const timeoutExpectation = expect(pendingTimeout).resolves.toEqual({
			messageId: 'msg-1',
			message: { status: 'mirrored' },
			events: [
				{ eventId: 'evt-1', result: { status: 'timeout' } },
				{ eventId: 'evt-2', result: { status: 'timeout' } },
			],
			eventsTruncated: false,
		})
		await vi.advanceTimersByTimeAsync(mailboxMirrorRpcTimeoutMs)
		await timeoutExpectation
		expect(hangWrite).toHaveBeenCalledWith(
			expect.objectContaining({
				blobs: [
					'mailbox_mirror:upsert_delivery_event_batch',
					'timeout',
					expect.any(String),
				],
			}),
		)

		const failingBatch = vi.fn(async () => {
			throw new Error('batch exploded')
		})
		const { env: failEnv, writeDataPoint: failWrite } = fakeMailboxEnv({
			mirrorMessage,
			upsertDeliveryEvents: failingBatch,
		})
		const failSummary = await mirrorMailboxMessageGraphFromD1({
			env: failEnv,
			db,
			userId: 'user-aaa',
			messageId: 'msg-1',
		})
		expect(failSummary.events).toEqual([
			{
				eventId: 'evt-1',
				result: {
					status: 'error',
					error: expect.objectContaining({ message: 'batch exploded' }),
				},
			},
			{
				eventId: 'evt-2',
				result: {
					status: 'error',
					error: expect.objectContaining({ message: 'batch exploded' }),
				},
			},
		])
		expect(failWrite).toHaveBeenCalledWith(
			expect.objectContaining({
				blobs: [
					'mailbox_mirror:upsert_delivery_event_batch',
					'error',
					expect.any(String),
				],
			}),
		)
	} finally {
		vi.useRealTimers()
	}
})

test('live-mirror graph returns missing when D1 message is absent', async () => {
	const { db } = await createEmailDb()
	const mirrorMessage = vi.fn(async () => ({
		ok: true as const,
		accepted: true,
	}))
	const upsertDeliveryEvents = vi.fn()
	const { env } = fakeMailboxEnv({ mirrorMessage, upsertDeliveryEvents })

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
	expect(upsertDeliveryEvents).not.toHaveBeenCalled()
})

test('live-mirror graph returns missing for cross-owner message without RPCs', async () => {
	const { db } = await createEmailDb()
	await seedMessageGraph(db)
	const mirrorMessage = vi.fn(async () => ({
		ok: true as const,
		accepted: true,
	}))
	const upsertDeliveryEvents = vi.fn(async () => ({
		results: [],
	}))
	const { env } = fakeMailboxEnv({ mirrorMessage, upsertDeliveryEvents })

	await expect(
		mirrorMailboxMessageGraphFromD1({
			env,
			db,
			userId: 'other-user',
			messageId: 'msg-1',
		}),
	).resolves.toEqual({
		messageId: 'msg-1',
		message: { status: 'missing' },
		events: [],
		eventsTruncated: false,
	})
	expect(mirrorMessage).not.toHaveBeenCalled()
	expect(upsertDeliveryEvents).not.toHaveBeenCalled()
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
