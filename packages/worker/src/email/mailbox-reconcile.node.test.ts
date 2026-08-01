import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import type * as MailboxMirrorModule from './mailbox-mirror.ts'
import {
	mailboxParityContentPageSize,
	mailboxParityMessagePageSize,
} from './mailbox-parity-phases.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const mocks = vi.hoisted(() => ({
	mirrorMailboxMessageGraphFromD1: vi.fn(),
	mirrorMailboxDeliveryEventFromD1: vi.fn(),
	awaitMailboxMirrorRpc: vi.fn(),
	recordMailboxParityEvent: vi.fn(),
	mailboxRpc: vi.fn(),
}))

vi.mock('./mailbox-live-mirror.ts', () => ({
	mirrorMailboxMessageGraphFromD1: mocks.mirrorMailboxMessageGraphFromD1,
	mirrorMailboxDeliveryEventFromD1: mocks.mirrorMailboxDeliveryEventFromD1,
}))

vi.mock('./mailbox-mirror.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxMirrorModule>()
	return {
		...actual,
		awaitMailboxMirrorRpc: mocks.awaitMailboxMirrorRpc,
	}
})

vi.mock('./mailbox-parity-events.ts', () => ({
	recordMailboxParityEvent: mocks.recordMailboxParityEvent,
}))

vi.mock('./mailbox-client.ts', () => ({
	mailboxRpc: mocks.mailboxRpc,
}))

const {
	countD1MailboxParity,
	listEventBackfillPage,
	listUsersForMailboxParity,
	reconcileMailboxParity,
} = await import('./mailbox-reconcile.ts')

async function createParityDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db })
	await ensureEmailTestSchema(db)
	return { sqlite, db }
}

async function insertUser(input: {
	db: D1Database
	userId: string
	email?: string
	deletingAt?: string | null
	checkedAt?: string | null
}) {
	await input.db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, deleting_at,
				mailbox_parity_checked_at
			) VALUES (?, ?, 'hash', ?, ?, ?)`,
		)
		.bind(
			`u-${crypto.randomUUID().slice(0, 8)}`,
			input.email ?? `${crypto.randomUUID()}@example.test`,
			input.userId,
			input.deletingAt ?? null,
			input.checkedAt ?? null,
		)
		.run()
}

async function insertMessage(input: {
	db: D1Database
	userId: string
	id: string
	createdAt: string
	updatedAt?: string
}) {
	await input.db
		.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, from_address, subject, text_body, raw_size,
				processing_status, created_at, updated_at
			) VALUES (?, 'inbound', ?, 'from@example.test', 'hi', 'body', 4,
				'stored', ?, ?)`,
		)
		.bind(
			input.id,
			input.userId,
			input.createdAt,
			input.updatedAt ?? input.createdAt,
		)
		.run()
}

async function insertEvent(input: {
	db: D1Database
	userId: string
	id: string
	createdAt: string
	messageId?: string | null
}) {
	await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, event_type, provider, detail_json, created_at
			) VALUES (?, ?, ?, 'receive_started', 'cloudflare-email-routing', '{}', ?)`,
		)
		.bind(
			input.id,
			input.messageId === undefined ? null : input.messageId,
			input.userId,
			input.createdAt,
		)
		.run()
}

async function parkUser(db: D1Database, userId: string) {
	await db
		.prepare(
			`UPDATE users
			SET mailbox_parity_checked_at = '9999-01-01T00:00:00.000Z'
			WHERE stable_user_id = ?`,
		)
		.bind(userId)
		.run()
}

async function readParityRow(db: D1Database, userId: string) {
	return db
		.prepare(
			`SELECT
				mailbox_parity_checked_at AS checkedAt,
				mailbox_parity_matching_since AS matchingSince,
				mailbox_parity_mismatch_count AS mismatchCount,
				mailbox_parity_last_error AS lastError,
				mailbox_parity_content_watermark_at AS contentWatermarkAt,
				mailbox_parity_content_replay_upper_at AS contentReplayUpperAt,
				mailbox_parity_content_replay_cursor_updated_at AS contentReplayCursorUpdatedAt,
				mailbox_parity_content_replay_cursor_id AS contentReplayCursorId,
				mailbox_parity_message_backfill_cursor_created_at AS messageCursorCreatedAt,
				mailbox_parity_message_backfill_cursor_id AS messageCursorId,
				mailbox_parity_message_backfill_completed_at AS messagesCompletedAt,
				mailbox_parity_event_backfill_cursor_created_at AS eventCursorCreatedAt,
				mailbox_parity_event_backfill_cursor_id AS eventCursorId,
				mailbox_parity_event_backfill_completed_at AS eventsCompletedAt
			FROM users
			WHERE stable_user_id = ?`,
		)
		.bind(userId)
		.first<{
			checkedAt: string | null
			matchingSince: string | null
			mismatchCount: number
			lastError: string | null
			contentWatermarkAt: string | null
			contentReplayUpperAt: string | null
			contentReplayCursorUpdatedAt: string | null
			contentReplayCursorId: string | null
			messageCursorCreatedAt: string | null
			messageCursorId: string | null
			messagesCompletedAt: string | null
			eventCursorCreatedAt: string | null
			eventCursorId: string | null
			eventsCompletedAt: string | null
		}>()
}

function successGraph(messageId: string, eventsTruncated = false) {
	return {
		messageId,
		message: { status: 'mirrored' as const },
		events: [],
		eventsTruncated,
	}
}

function mockDoCounts(
	counts: {
		threads: number
		messages: number
		attachments: number
		deliveryEvents: number
	},
	options?: { purge?: () => Promise<{ ok: true }> },
) {
	const purge = options?.purge ?? vi.fn(async () => ({ ok: true as const }))
	mocks.mailboxRpc.mockImplementation(() => ({
		countMailbox: vi.fn(async () => counts),
		purge,
	}))
	mocks.awaitMailboxMirrorRpc.mockImplementation(
		async (promise: Promise<unknown>) => ({
			ok: true as const,
			value: await promise,
		}),
	)
	return { purge }
}

function parityEnv(db: D1Database) {
	return {
		APP_DB: db,
		MAILBOX: {} as DurableObjectNamespace,
		EMAIL_EVENTS: {
			writeDataPoint: vi.fn(),
		} as unknown as AnalyticsEngineDataset,
	}
}

test('mailbox parity multi-run cursor progress, isolation, soak, errors, and counts', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const ownerA = 'a'.repeat(64)
	const ownerB = 'b'.repeat(64)
	const deleting = 'c'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')

	await insertUser({ db, userId: ownerA, checkedAt: null })
	await insertUser({
		db,
		userId: ownerB,
		checkedAt: '2026-07-01T00:00:00.000Z',
	})
	await insertUser({
		db,
		userId: deleting,
		deletingAt: '2026-07-31T00:00:00.000Z',
		checkedAt: null,
	})

	const messageIds = Array.from(
		{ length: mailboxParityMessagePageSize + 1 },
		(_, index) => `msg-${String(index + 1).padStart(2, '0')}`,
	)
	for (const [index, id] of messageIds.entries()) {
		await insertMessage({
			db,
			userId: ownerA,
			id,
			createdAt: `2026-07-01T00:00:${String(index).padStart(2, '0')}.000Z`,
		})
	}
	await insertEvent({
		db,
		userId: ownerA,
		id: 'evt-bound-1',
		messageId: messageIds[0]!,
		createdAt: '2026-07-02T00:00:00.000Z',
	})
	await insertEvent({
		db,
		userId: ownerA,
		id: 'evt-orphan-1',
		createdAt: '2026-07-02T00:00:01.000Z',
	})
	await insertMessage({
		db,
		userId: ownerB,
		id: 'b-msg-1',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	await insertMessage({
		db,
		userId: systemEmailOwnerId,
		id: 'sys-msg-1',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	await insertEvent({
		db,
		userId: deleting,
		id: 'del-evt',
		createdAt: '2026-07-01T00:00:00.000Z',
	})

	const discovered = await listUsersForMailboxParity({ db, limit: 10 })
	expect(discovered.map((row) => row.userId)).toEqual([ownerA, ownerB])
	expect(discovered.map((row) => row.userId)).not.toContain(systemEmailOwnerId)
	expect(discovered.map((row) => row.userId)).not.toContain(deleting)

	const eventPage = await listEventBackfillPage({
		db,
		userId: ownerA,
		cursor: null,
		limit: 10,
	})
	expect(eventPage.map((row) => row.id)).toEqual([
		'evt-bound-1',
		'evt-orphan-1',
	])

	await db
		.prepare(
			`INSERT INTO email_threads (
				id, user_id, subject_normalized, last_message_at, created_at, updated_at
			) VALUES ('thread-a', ?, 'hi', ?, ?, ?)`,
		)
		.bind(
			ownerA,
			'2026-07-01T00:00:00.000Z',
			'2026-07-01T00:00:00.000Z',
			'2026-07-01T00:00:00.000Z',
		)
		.run()

	await expect(countD1MailboxParity({ db, userId: ownerA })).resolves.toEqual({
		threads: 1,
		messages: mailboxParityMessagePageSize + 1,
		attachments: 0,
		deliveryEvents: 2,
	})

	let graphCalls = 0
	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
		async (input: { messageId: string }) => {
			graphCalls += 1
			if (graphCalls === mailboxParityMessagePageSize) {
				return {
					messageId: input.messageId,
					message: { status: 'timeout' as const },
					events: [],
					eventsTruncated: false,
				}
			}
			return successGraph(input.messageId)
		},
	)
	mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
		status: 'mirrored',
	})
	mockDoCounts({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})

	const env = parityEnv(db)
	await db
		.prepare(
			`UPDATE users
			SET mailbox_parity_matching_since = '2026-07-01T00:00:00.000Z',
				mailbox_parity_mismatch_count = 2
			WHERE stable_user_id = ?`,
		)
		.bind(ownerA)
		.run()

	await parkUser(db, ownerB)
	const first = await reconcileMailboxParity({
		env,
		now,
		batchSize: 1,
	})
	expect(first).toEqual({
		scanned: 1,
		backfilled: mailboxParityMessagePageSize - 1,
		compared: 0,
		matched: 0,
		mismatched: 0,
		failed: 1,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'mailbox-parity-message-backfill-retryable',
		ownerA,
		'message graph timeout',
	)

	const afterFirst = await readParityRow(db, ownerA)
	expect(afterFirst).toMatchObject({
		checkedAt: now.toISOString(),
		messageCursorId: messageIds[mailboxParityMessagePageSize - 2],
		messagesCompletedAt: null,
		eventsCompletedAt: null,
		contentWatermarkAt: now.toISOString(),
		matchingSince: null,
		mismatchCount: 2,
		lastError: 'message backfill message graph timeout',
	})

	// Finish creation; count mismatch resets BOTH cursors + completion markers.
	graphCalls = 0
	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
		async (input: { messageId: string }) => successGraph(input.messageId),
	)
	mocks.mirrorMailboxMessageGraphFromD1.mockClear()
	mocks.mirrorMailboxDeliveryEventFromD1.mockClear()
	mocks.recordMailboxParityEvent.mockClear()
	await parkUser(db, ownerB)
	const mismatchNow = new Date('2026-08-01T11:00:00.000Z')
	const mismatch = await reconcileMailboxParity({
		env,
		now: mismatchNow,
		batchSize: 1,
	})
	expect(mismatch).toEqual({
		scanned: 1,
		backfilled: 4,
		compared: 1,
		matched: 0,
		mismatched: 1,
		failed: 0,
	})
	expect(mocks.mirrorMailboxDeliveryEventFromD1).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerA, eventId: 'evt-bound-1' }),
	)
	expect(mocks.mirrorMailboxDeliveryEventFromD1).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerA, eventId: 'evt-orphan-1' }),
	)

	const afterMismatch = await readParityRow(db, ownerA)
	expect(afterMismatch).toMatchObject({
		checkedAt: mismatchNow.toISOString(),
		matchingSince: null,
		mismatchCount: 3,
		contentWatermarkAt: null,
		contentReplayUpperAt: null,
		contentReplayCursorId: null,
		messagesCompletedAt: null,
		eventsCompletedAt: null,
		messageCursorId: null,
		eventCursorId: null,
		lastError: null,
	})

	// Full historical rescan after cursor reset, including a live new row.
	await insertMessage({
		db,
		userId: ownerA,
		id: 'msg-live-new',
		createdAt: '2026-07-03T00:00:00.000Z',
	})
	mocks.mirrorMailboxMessageGraphFromD1.mockClear()
	mocks.mirrorMailboxDeliveryEventFromD1.mockClear()
	mockDoCounts({
		threads: 1,
		messages: mailboxParityMessagePageSize + 2,
		attachments: 0,
		deliveryEvents: 2,
	})
	await parkUser(db, ownerB)
	const rematchNow = new Date('2026-08-01T12:00:00.000Z')
	const rematch = await reconcileMailboxParity({
		env,
		now: rematchNow,
		batchSize: 1,
	})
	expect(rematch).toEqual({
		scanned: 1,
		backfilled: mailboxParityMessagePageSize + 4,
		compared: 1,
		matched: 1,
		mismatched: 0,
		failed: 0,
	})
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerA, messageId: 'msg-live-new' }),
	)
	const afterRematch = await readParityRow(db, ownerA)
	expect(afterRematch).toMatchObject({
		matchingSince: rematchNow.toISOString(),
		mismatchCount: 0,
		contentWatermarkAt: expect.any(String),
		messagesCompletedAt: expect.any(String),
		eventsCompletedAt: expect.any(String),
		messageCursorId: 'msg-live-new',
		eventCursorId: 'evt-orphan-1',
	})
	if (!afterRematch?.contentWatermarkAt) {
		throw new Error('Expected content watermark after parity rematch.')
	}
	expect(afterRematch.contentWatermarkAt >= rematchNow.toISOString()).toBe(true)

	await parkUser(db, ownerB)
	const soakNow = new Date('2026-08-02T12:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: soakNow, batchSize: 1 }),
	).resolves.toEqual({
		scanned: 1,
		backfilled: 0,
		compared: 1,
		matched: 1,
		mismatched: 0,
		failed: 0,
	})
	const afterSoak = await readParityRow(db, ownerA)
	expect(afterSoak?.matchingSince).toBe(rematchNow.toISOString())
	expect(afterSoak?.contentWatermarkAt).toBe(soakNow.toISOString())
	expect(afterSoak?.mismatchCount).toBe(0)

	consoleWarn.mockClear()
	mocks.awaitMailboxMirrorRpc.mockRejectedValueOnce(
		new Error('count boom\nwith\tcontrol'),
	)
	await parkUser(db, ownerB)
	const errorNow = new Date('2026-08-02T13:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: errorNow, batchSize: 1 }),
	).resolves.toMatchObject({ failed: 1, compared: 0 })
	const afterError = await readParityRow(db, ownerA)
	expect(afterError?.checkedAt).toBe(errorNow.toISOString())
	expect(afterError?.lastError).toBe('count boom with control')
	expect(afterError?.matchingSince).toBeNull()
})

test('mailbox parity content watermark repairs equal-count updates and soak', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.useFakeTimers()
	const { db } = await createParityDb()
	const owner = 'd'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	vi.setSystemTime(now)

	try {
		await insertUser({ db, userId: owner, checkedAt: null })
		await insertMessage({
			db,
			userId: owner,
			id: 'msg-a',
			createdAt: '2026-07-01T00:00:00.000Z',
		})
		await insertMessage({
			db,
			userId: owner,
			id: 'msg-b',
			createdAt: '2026-07-01T00:00:01.000Z',
		})

		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => successGraph(input.messageId),
		)
		mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
			status: 'mirrored',
		})
		mockDoCounts({
			threads: 0,
			messages: 2,
			attachments: 0,
			deliveryEvents: 0,
		})
		const env = parityEnv(db)

		await expect(
			reconcileMailboxParity({ env, now, batchSize: 1 }),
		).resolves.toMatchObject({ matched: 1, compared: 1 })
		expect((await readParityRow(db, owner))?.contentWatermarkAt).toBe(
			now.toISOString(),
		)

		const sharedUpdatedAt = '2026-08-01T10:30:00.000Z'
		await db
			.prepare(
				`UPDATE email_messages
				SET classification = 'quarantined', updated_at = ?
				WHERE id IN ('msg-a', 'msg-b')`,
			)
			.bind(sharedUpdatedAt)
			.run()
		mocks.mirrorMailboxMessageGraphFromD1.mockClear()
		const repairNow = new Date('2026-08-01T11:00:00.000Z')
		vi.setSystemTime(repairNow)
		await expect(
			reconcileMailboxParity({ env, now: repairNow, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 2,
			compared: 1,
			matched: 1,
			mismatched: 0,
			failed: 0,
		})
		expect(
			mocks.mirrorMailboxMessageGraphFromD1.mock.calls.map(
				(call) => call[0].messageId as string,
			),
		).toEqual(['msg-a', 'msg-b'])
		const afterRepair = await readParityRow(db, owner)
		expect(afterRepair?.matchingSince).toBe(now.toISOString())
		expect(afterRepair?.contentWatermarkAt).toBe(repairNow.toISOString())
		expect(afterRepair?.contentReplayUpperAt).toBeNull()
	} finally {
		vi.useRealTimers()
	}
})

test('mailbox parity replays message updated during initial backfill', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.useFakeTimers()
	const { db } = await createParityDb()
	const owner = 'e'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	const midUpdateAt = new Date('2026-08-01T10:00:05.000Z')
	vi.setSystemTime(now)

	try {
		await insertUser({ db, userId: owner, checkedAt: null })
		await insertMessage({
			db,
			userId: owner,
			id: 'msg-early',
			createdAt: '2026-07-01T00:00:00.000Z',
		})
		await insertMessage({
			db,
			userId: owner,
			id: 'msg-late',
			createdAt: '2026-07-01T00:00:01.000Z',
		})
		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => {
				if (input.messageId === 'msg-early') {
					vi.setSystemTime(midUpdateAt)
					await db
						.prepare(
							`UPDATE email_messages
							SET classification = 'quarantined', updated_at = ?
							WHERE id = 'msg-early'`,
						)
						.bind(midUpdateAt.toISOString())
						.run()
				}
				return successGraph(input.messageId)
			},
		)
		mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
			status: 'mirrored',
		})
		mockDoCounts({
			threads: 0,
			messages: 2,
			attachments: 0,
			deliveryEvents: 0,
		})
		await expect(
			reconcileMailboxParity({
				env: parityEnv(db),
				now,
				batchSize: 1,
			}),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 3,
			compared: 1,
			matched: 1,
			mismatched: 0,
			failed: 0,
		})
		expect(
			mocks.mirrorMailboxMessageGraphFromD1.mock.calls.map(
				(call) => call[0].messageId as string,
			),
		).toEqual(['msg-early', 'msg-late', 'msg-early'])
		expect((await readParityRow(db, owner))?.contentWatermarkAt).toBe(
			midUpdateAt.toISOString(),
		)
	} finally {
		vi.useRealTimers()
	}
})

test('mailbox parity content replay resumes durable upper and cursor across ticks', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.useFakeTimers()
	const { db } = await createParityDb()
	const owner = 'f'.repeat(64)
	const baseline = new Date('2026-08-01T10:00:00.000Z')
	vi.setSystemTime(baseline)

	try {
		await insertUser({ db, userId: owner, checkedAt: null })
		const messageCount = mailboxParityContentPageSize + 2
		for (let index = 0; index < messageCount; index += 1) {
			await insertMessage({
				db,
				userId: owner,
				id: `msg-${String(index).padStart(2, '0')}`,
				createdAt: `2026-07-01T00:00:${String(index).padStart(2, '0')}.000Z`,
			})
		}
		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => successGraph(input.messageId),
		)
		mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
			status: 'mirrored',
		})
		mockDoCounts({
			threads: 0,
			messages: messageCount,
			attachments: 0,
			deliveryEvents: 0,
		})
		const env = parityEnv(db)
		await reconcileMailboxParity({ env, now: baseline, batchSize: 1 })

		const updateAt = '2026-08-01T10:30:00.000Z'
		await db
			.prepare(`UPDATE email_messages SET updated_at = ? WHERE user_id = ?`)
			.bind(updateAt, owner)
			.run()

		const replayNow = new Date('2026-08-01T11:00:00.000Z')
		vi.setSystemTime(replayNow)
		let contentCalls = 0
		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => {
				contentCalls += 1
				if (contentCalls === mailboxParityContentPageSize) {
					// Exhaust budget mid-window by freezing time past deadline.
					vi.setSystemTime(new Date(replayNow.getTime() + 20_000))
				}
				return successGraph(input.messageId)
			},
		)
		await expect(
			reconcileMailboxParity({ env, now: replayNow, batchSize: 1 }),
		).resolves.toMatchObject({
			compared: 0,
			failed: 0,
			backfilled: mailboxParityContentPageSize,
		})
		const mid = await readParityRow(db, owner)
		expect(mid).toMatchObject({
			contentWatermarkAt: baseline.toISOString(),
			contentReplayUpperAt: replayNow.toISOString(),
			contentReplayCursorId: `msg-${String(mailboxParityContentPageSize - 1).padStart(2, '0')}`,
			matchingSince: null,
		})

		vi.setSystemTime(replayNow)
		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => successGraph(input.messageId),
		)
		mocks.mirrorMailboxMessageGraphFromD1.mockClear()
		await expect(
			reconcileMailboxParity({ env, now: replayNow, batchSize: 1 }),
		).resolves.toMatchObject({
			compared: 1,
			matched: 1,
			backfilled: 2,
		})
		expect(
			mocks.mirrorMailboxMessageGraphFromD1.mock.calls.map(
				(call) => call[0].messageId as string,
			),
		).toEqual([
			`msg-${String(mailboxParityContentPageSize).padStart(2, '0')}`,
			`msg-${String(mailboxParityContentPageSize + 1).padStart(2, '0')}`,
		])
		const done = await readParityRow(db, owner)
		expect(done).toMatchObject({
			contentWatermarkAt: replayNow.toISOString(),
			contentReplayUpperAt: null,
			contentReplayCursorId: null,
			// Soak was cleared on the incomplete tick; exact compare starts a new window.
			matchingSince: replayNow.toISOString(),
		})
	} finally {
		vi.useRealTimers()
	}
})

test('mailbox parity missing and unconfigured do not advance creation cursors', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const owner = 'g'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	await insertUser({ db, userId: owner, checkedAt: null })
	await insertMessage({
		db,
		userId: owner,
		id: 'msg-1',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	await insertMessage({
		db,
		userId: owner,
		id: 'msg-2',
		createdAt: '2026-07-01T00:00:01.000Z',
	})
	await insertEvent({
		db,
		userId: owner,
		id: 'evt-1',
		messageId: 'msg-1',
		createdAt: '2026-07-01T00:00:02.000Z',
	})

	mocks.mirrorMailboxMessageGraphFromD1.mockResolvedValueOnce({
		messageId: 'msg-1',
		message: { status: 'missing' as const },
		events: [],
		eventsTruncated: false,
	})
	mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
		status: 'mirrored',
	})
	mockDoCounts({
		threads: 0,
		messages: 2,
		attachments: 0,
		deliveryEvents: 1,
	})
	const env = parityEnv(db)
	await expect(
		reconcileMailboxParity({ env, now, batchSize: 1 }),
	).resolves.toMatchObject({ failed: 1, backfilled: 0, compared: 0 })
	expect(await readParityRow(db, owner)).toMatchObject({
		messageCursorId: null,
		messagesCompletedAt: null,
		contentWatermarkAt: now.toISOString(),
		lastError: 'message backfill message graph missing',
	})

	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
		async (input: { messageId: string }) => successGraph(input.messageId),
	)
	mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValueOnce({
		status: 'skipped',
		reason: 'mailbox-unconfigured',
	})
	await expect(
		reconcileMailboxParity({
			env,
			now: new Date('2026-08-01T11:00:00.000Z'),
			batchSize: 1,
		}),
	).resolves.toMatchObject({ failed: 1, compared: 0 })
	const afterUnconfigured = await readParityRow(db, owner)
	expect(afterUnconfigured).toMatchObject({
		messagesCompletedAt: expect.any(String),
		eventCursorId: null,
		eventsCompletedAt: null,
		lastError: 'event backfill event skipped:mailbox-unconfigured',
	})
})

test('mailbox parity eventsTruncated still completes via full event phase', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const owner = 'h'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	await insertUser({ db, userId: owner, checkedAt: null })
	await insertMessage({
		db,
		userId: owner,
		id: 'msg-1',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	for (let index = 0; index < 3; index += 1) {
		await insertEvent({
			db,
			userId: owner,
			id: `evt-${index}`,
			messageId: 'msg-1',
			createdAt: `2026-07-01T00:01:0${index}.000Z`,
		})
	}
	mocks.mirrorMailboxMessageGraphFromD1.mockResolvedValue(
		successGraph('msg-1', true),
	)
	mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
		status: 'mirrored',
	})
	mockDoCounts({
		threads: 0,
		messages: 1,
		attachments: 0,
		deliveryEvents: 3,
	})
	await expect(
		reconcileMailboxParity({
			env: parityEnv(db),
			now,
			batchSize: 1,
		}),
	).resolves.toEqual({
		scanned: 1,
		backfilled: 4,
		compared: 1,
		matched: 1,
		mismatched: 0,
		failed: 0,
	})
	expect(mocks.mirrorMailboxDeliveryEventFromD1).toHaveBeenCalledTimes(3)
})

test('mailbox parity event missing advances cursor while unconfigured does not', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const owner = 'j'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	await insertUser({ db, userId: owner, checkedAt: null })
	await insertMessage({
		db,
		userId: owner,
		id: 'msg-1',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	await insertEvent({
		db,
		userId: owner,
		id: 'evt-gone',
		messageId: 'msg-1',
		createdAt: '2026-07-01T00:00:01.000Z',
	})
	await insertEvent({
		db,
		userId: owner,
		id: 'evt-ok',
		messageId: 'msg-1',
		createdAt: '2026-07-01T00:00:02.000Z',
	})
	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
		async (input: { messageId: string }) => successGraph(input.messageId),
	)
	mocks.mirrorMailboxDeliveryEventFromD1
		.mockResolvedValueOnce({ status: 'missing' })
		.mockResolvedValueOnce({ status: 'mirrored' })
	mockDoCounts({
		threads: 0,
		messages: 1,
		attachments: 0,
		deliveryEvents: 2,
	})
	await expect(
		reconcileMailboxParity({
			env: parityEnv(db),
			now,
			batchSize: 1,
		}),
	).resolves.toMatchObject({ matched: 1, failed: 0 })
	expect(await readParityRow(db, owner)).toMatchObject({
		eventCursorId: 'evt-ok',
		eventsCompletedAt: expect.any(String),
	})
})

test('mailbox parity deletion race purges Mailbox and skips parity writes', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const owner = 'i'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	await insertUser({ db, userId: owner, checkedAt: null })
	await insertMessage({
		db,
		userId: owner,
		id: 'msg-1',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	const purge = vi.fn(async () => ({ ok: true as const }))
	mocks.mailboxRpc.mockImplementation(() => ({
		countMailbox: vi.fn(async () => ({
			threads: 0,
			messages: 0,
			attachments: 0,
			deliveryEvents: 0,
		})),
		purge,
	}))
	mocks.awaitMailboxMirrorRpc.mockImplementation(
		async (promise: Promise<unknown>) => {
			try {
				return { ok: true as const, value: await promise }
			} catch {
				return { ok: false as const, result: { status: 'timeout' as const } }
			}
		},
	)
	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(async () => {
		await db
			.prepare(`UPDATE users SET deleting_at = ? WHERE stable_user_id = ?`)
			.bind(now.toISOString(), owner)
			.run()
		return successGraph('msg-1')
	})
	mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
		status: 'mirrored',
	})

	await expect(
		reconcileMailboxParity({
			env: parityEnv(db),
			now,
			batchSize: 1,
		}),
	).resolves.toEqual({
		scanned: 1,
		backfilled: 0,
		compared: 0,
		matched: 0,
		mismatched: 0,
		failed: 0,
	})
	expect(purge).toHaveBeenCalledTimes(1)
	const row = await readParityRow(db, owner)
	// Baseline may have been written before deletion; no completion/compare state.
	expect(row?.messagesCompletedAt).toBeNull()
	expect(row?.matchingSince).toBeNull()
	expect(row?.eventsCompletedAt).toBeNull()
})

test('tracked empty user discovers DO-only leftover, purges, then reaches zero parity', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const owner = 'k'.repeat(64)
	const neverTracked = 'l'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	await insertUser({ db, userId: owner, checkedAt: null })
	await insertUser({ db, userId: neverTracked, checkedAt: null })
	await insertMessage({
		db,
		userId: owner,
		id: 'msg-1',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	await insertEvent({
		db,
		userId: owner,
		id: 'evt-1',
		messageId: 'msg-1',
		createdAt: '2026-07-01T00:00:01.000Z',
	})
	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
		async (input: { messageId: string }) => successGraph(input.messageId),
	)
	mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
		status: 'mirrored',
	})
	const purge = vi.fn(async () => ({ ok: true as const }))
	mockDoCounts(
		{
			threads: 0,
			messages: 1,
			attachments: 0,
			deliveryEvents: 1,
		},
		{ purge },
	)
	const env = parityEnv(db)
	await expect(
		reconcileMailboxParity({ env, now, batchSize: 1 }),
	).resolves.toMatchObject({ matched: 1, compared: 1 })

	// Simulate failed delete mirror: D1 cleared, DO still holds message/event.
	await db
		.prepare(`DELETE FROM email_delivery_events WHERE user_id = ?`)
		.bind(owner)
		.run()
	await db
		.prepare(`DELETE FROM email_messages WHERE user_id = ?`)
		.bind(owner)
		.run()

	expect(
		(await listUsersForMailboxParity({ db, limit: 10 })).map(
			(row) => row.userId,
		),
	).toEqual([owner])
	expect(
		(await listUsersForMailboxParity({ db, limit: 10 })).map(
			(row) => row.userId,
		),
	).not.toContain(neverTracked)

	mockDoCounts(
		{
			threads: 0,
			messages: 1,
			attachments: 0,
			deliveryEvents: 1,
		},
		{ purge },
	)
	const mismatchNow = new Date('2026-08-01T11:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: mismatchNow, batchSize: 1 }),
	).resolves.toEqual({
		scanned: 1,
		backfilled: 0,
		compared: 1,
		matched: 0,
		mismatched: 1,
		failed: 0,
	})
	expect(purge).toHaveBeenCalledTimes(1)
	const afterPurge = await readParityRow(db, owner)
	expect(afterPurge).toMatchObject({
		matchingSince: null,
		mismatchCount: 1,
		contentWatermarkAt: null,
		messagesCompletedAt: null,
		eventsCompletedAt: null,
		messageCursorId: null,
		eventCursorId: null,
		lastError: null,
	})

	mockDoCounts({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})
	const zeroNow = new Date('2026-08-01T12:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: zeroNow, batchSize: 1 }),
	).resolves.toEqual({
		scanned: 1,
		backfilled: 0,
		compared: 1,
		matched: 1,
		mismatched: 0,
		failed: 0,
	})
	const afterZero = await readParityRow(db, owner)
	expect(afterZero).toMatchObject({
		matchingSince: zeroNow.toISOString(),
		mismatchCount: 0,
		contentWatermarkAt: expect.any(String),
	})
	if (!afterZero?.contentWatermarkAt) {
		throw new Error('Expected content watermark after zero-count parity.')
	}
	expect(afterZero.contentWatermarkAt >= zeroNow.toISOString()).toBe(true)
})

test('mismatch purge failure clears soak and does not start rebuild reset', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.useFakeTimers()
	const { db } = await createParityDb()
	const owner = 'm'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	vi.setSystemTime(now)

	try {
		await insertUser({ db, userId: owner, checkedAt: null })
		await insertMessage({
			db,
			userId: owner,
			id: 'msg-1',
			createdAt: '2026-07-01T00:00:00.000Z',
		})
		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => successGraph(input.messageId),
		)
		mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
			status: 'mirrored',
		})
		mockDoCounts({
			threads: 0,
			messages: 1,
			attachments: 0,
			deliveryEvents: 0,
		})
		const env = parityEnv(db)
		await expect(
			reconcileMailboxParity({ env, now, batchSize: 1 }),
		).resolves.toMatchObject({ matched: 1 })
		const afterMatch = await readParityRow(db, owner)
		expect(afterMatch?.messagesCompletedAt).toEqual(expect.any(String))
		expect(afterMatch?.contentWatermarkAt).toBe(now.toISOString())

		mocks.mailboxRpc.mockImplementation(() => ({
			countMailbox: vi.fn(async () => ({
				threads: 0,
				messages: 2,
				attachments: 0,
				deliveryEvents: 0,
			})),
			purge: vi.fn(async () => ({ ok: true as const })),
		}))
		mocks.awaitMailboxMirrorRpc.mockImplementation(
			async (promise: Promise<unknown>) => {
				const settled = await promise
				if (settled && typeof settled === 'object' && 'messages' in settled) {
					return { ok: true as const, value: settled }
				}
				return { ok: false as const, timedOut: true as const }
			},
		)
		consoleWarn.mockClear()
		const failNow = new Date('2026-08-01T11:00:00.000Z')
		vi.setSystemTime(failNow)
		await expect(
			reconcileMailboxParity({ env, now: failNow, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 0,
			compared: 1,
			matched: 0,
			mismatched: 1,
			failed: 1,
		})
		expect(consoleWarn).toHaveBeenCalledWith(
			'mailbox-parity-mismatch-purge-failed',
			owner,
			'timeout',
			'mailbox metadata purge timeout',
		)
		const afterFail = await readParityRow(db, owner)
		// Empty content window may advance the watermark before compare; purge
		// failure must not clear creation completion/cursors (rebuild not started).
		expect(afterFail).toMatchObject({
			matchingSince: null,
			mismatchCount: 1,
			messagesCompletedAt: afterMatch?.messagesCompletedAt,
			eventsCompletedAt: afterMatch?.eventsCompletedAt,
			messageCursorId: afterMatch?.messageCursorId,
			lastError: 'mailbox metadata purge timeout',
			checkedAt: failNow.toISOString(),
		})
		expect(afterFail?.contentWatermarkAt).not.toBeNull()
	} finally {
		vi.useRealTimers()
	}
})
