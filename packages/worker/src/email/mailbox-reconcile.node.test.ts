import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import type * as MailboxMirrorModule from './mailbox-mirror.ts'
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
	listOrphanDeliveryEventBackfillPage,
	listUsersForMailboxParity,
	mailboxParityMessagePageSize,
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
}) {
	await input.db
		.prepare(
			`INSERT INTO email_messages (
				id, direction, user_id, from_address, subject, text_body, raw_size,
				processing_status, created_at, updated_at
			) VALUES (?, 'inbound', ?, 'from@example.test', 'hi', 'body', 4,
				'stored', ?, ?)`,
		)
		.bind(input.id, input.userId, input.createdAt, input.createdAt)
		.run()
}

async function insertOrphanEvent(input: {
	db: D1Database
	userId: string
	id: string
	createdAt: string
}) {
	await input.db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, event_type, provider, detail_json, created_at
			) VALUES (?, NULL, ?, 'receive_started', 'cloudflare-email-routing', '{}', ?)`,
		)
		.bind(input.id, input.userId, input.createdAt)
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
				mailbox_parity_message_backfill_cursor_created_at AS messageCursorCreatedAt,
				mailbox_parity_message_backfill_cursor_id AS messageCursorId,
				mailbox_parity_message_backfill_completed_at AS messagesCompletedAt,
				mailbox_parity_orphan_event_backfill_cursor_created_at AS orphanCursorCreatedAt,
				mailbox_parity_orphan_event_backfill_cursor_id AS orphanCursorId,
				mailbox_parity_orphan_event_backfill_completed_at AS orphanEventsCompletedAt
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
			messageCursorCreatedAt: string | null
			messageCursorId: string | null
			messagesCompletedAt: string | null
			orphanCursorCreatedAt: string | null
			orphanCursorId: string | null
			orphanEventsCompletedAt: string | null
		}>()
}

function successGraph(messageId: string) {
	return {
		messageId,
		message: { status: 'mirrored' as const },
		events: [],
		eventsTruncated: false,
	}
}

function mockDoCounts(counts: {
	threads: number
	messages: number
	attachments: number
	deliveryEvents: number
}) {
	mocks.awaitMailboxMirrorRpc.mockResolvedValue({
		ok: true,
		value: counts,
	})
	mocks.mailboxRpc.mockImplementation(() => ({
		countMailbox: vi.fn(async () => counts),
	}))
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
	await insertOrphanEvent({
		db,
		userId: ownerA,
		id: 'orphan-1',
		createdAt: '2026-07-02T00:00:00.000Z',
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
	await insertOrphanEvent({
		db,
		userId: deleting,
		id: 'del-orphan',
		createdAt: '2026-07-01T00:00:00.000Z',
	})

	// NULL checked_at sorts first under ORDER BY checked_at ASC (index-friendly).
	const discovered = await listUsersForMailboxParity({ db, limit: 10 })
	expect(discovered.map((row) => row.userId)).toEqual([ownerA, ownerB])
	expect(discovered.map((row) => row.userId)).not.toContain(systemEmailOwnerId)
	expect(discovered.map((row) => row.userId)).not.toContain(deleting)

	const orphanPage = await listOrphanDeliveryEventBackfillPage({
		db,
		userId: ownerA,
		cursor: null,
		limit: 10,
	})
	expect(orphanPage).toEqual([
		{ id: 'orphan-1', created_at: '2026-07-02T00:00:00.000Z' },
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
	await db
		.prepare(
			`INSERT INTO email_attachments (
				id, message_id, content_type, size, storage_kind, created_at
			) VALUES ('att-1', ?, 'text/plain', 1, 'unavailable', ?)`,
		)
		.bind(messageIds[0]!, '2026-07-01T00:00:00.000Z')
		.run()

	await expect(countD1MailboxParity({ db, userId: ownerA })).resolves.toEqual({
		threads: 1,
		messages: mailboxParityMessagePageSize + 1,
		attachments: 1,
		deliveryEvents: 1,
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
	mocks.recordMailboxParityEvent.mockClear()

	const env = {
		APP_DB: db,
		MAILBOX: {} as DurableObjectNamespace,
		EMAIL_EVENTS: {
			writeDataPoint: vi.fn(),
		} as unknown as AnalyticsEngineDataset,
	}

	// Seed a false soak that must clear on mirror timeout / backfill work.
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
		'error-or-timeout',
	)
	expect(
		mocks.mirrorMailboxMessageGraphFromD1.mock.calls.every(
			(call) => call[0].userId === ownerA,
		),
	).toBe(true)
	expect(mocks.mailboxRpc).not.toHaveBeenCalled()

	const afterFirst = await readParityRow(db, ownerA)
	expect(afterFirst).toMatchObject({
		checkedAt: now.toISOString(),
		messageCursorId: messageIds[mailboxParityMessagePageSize - 2],
		messagesCompletedAt: null,
		orphanEventsCompletedAt: null,
		// Baseline is persisted at first backfill attempt start and retained.
		contentWatermarkAt: now.toISOString(),
		matchingSince: null,
		mismatchCount: 2,
		lastError: 'message backfill mirror error or timeout',
	})

	// Finish backfill; compare mismatches → reopen completed_at, retain cursors,
	// increment consecutive mismatch count, keep matching_since cleared.
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
		backfilled: 3,
		compared: 1,
		matched: 0,
		mismatched: 1,
		failed: 0,
	})
	expect(mocks.mirrorMailboxDeliveryEventFromD1).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerA, eventId: 'orphan-1' }),
	)
	expect(mocks.recordMailboxParityEvent).toHaveBeenCalledTimes(4)

	const afterMismatch = await readParityRow(db, ownerA)
	expect(afterMismatch).toMatchObject({
		checkedAt: mismatchNow.toISOString(),
		matchingSince: null,
		mismatchCount: 3,
		contentWatermarkAt: mismatchNow.toISOString(),
		messagesCompletedAt: null,
		orphanEventsCompletedAt: null,
		messageCursorId: messageIds[mailboxParityMessagePageSize],
		orphanCursorId: 'orphan-1',
		lastError: null,
	})

	// Live new row after retained cursor must be repaired on the reopen pass.
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
		attachments: 1,
		deliveryEvents: 1,
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
		backfilled: 1,
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
		contentWatermarkAt: rematchNow.toISOString(),
		messagesCompletedAt: expect.any(String),
		orphanEventsCompletedAt: expect.any(String),
		messageCursorId: 'msg-live-new',
	})

	// 24h soak preservation: exact completed compare with empty content window
	// advances the watermark and keeps matching_since.
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
	expect(afterSoak?.checkedAt).toBe(soakNow.toISOString())
	expect(afterSoak?.mismatchCount).toBe(0)

	// Compare-path error rotates checked_at and clears matching_since.
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
	expect(consoleWarn).toHaveBeenCalledWith(
		'mailbox-parity-reconcile-user-failed',
		ownerA,
		expect.any(Error),
	)

	// Discovery stays D1-only: mailboxRpc is never used to enumerate candidates.
	const rpcCallsBefore = mocks.mailboxRpc.mock.calls.length
	const discoveryOnly = await listUsersForMailboxParity({ db, limit: 5 })
	expect(discoveryOnly.length).toBeGreaterThan(0)
	expect(mocks.mailboxRpc).toHaveBeenCalledTimes(rpcCallsBefore)
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

		const env = {
			APP_DB: db,
			MAILBOX: {} as DurableObjectNamespace,
			EMAIL_EVENTS: {
				writeDataPoint: vi.fn(),
			} as unknown as AnalyticsEngineDataset,
		}

		// Baseline at first-attempt start; empty same-run window; then compare.
		await expect(
			reconcileMailboxParity({ env, now, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 2,
			compared: 1,
			matched: 1,
			mismatched: 0,
			failed: 0,
		})
		const afterBaseline = await readParityRow(db, owner)
		expect(afterBaseline).toMatchObject({
			matchingSince: now.toISOString(),
			contentWatermarkAt: now.toISOString(),
			mismatchCount: 0,
		})

		// Classification-like update: same counts, newer updated_at past watermark.
		const sharedUpdatedAt = '2026-08-01T10:30:00.000Z'
		await db
			.prepare(
				`UPDATE email_messages
				SET classification = 'quarantined', updated_at = ?
				WHERE id = 'msg-a'`,
			)
			.bind(sharedUpdatedAt)
			.run()
		await db
			.prepare(
				`UPDATE email_messages
				SET classification = 'quarantined', updated_at = ?
				WHERE id = 'msg-b'`,
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
		const replayedIds = mocks.mirrorMailboxMessageGraphFromD1.mock.calls.map(
			(call) => call[0].messageId as string,
		)
		expect(replayedIds).toEqual(['msg-a', 'msg-b'])
		const afterRepair = await readParityRow(db, owner)
		// Successful content sweep + exact compare keeps the soak window.
		expect(afterRepair?.matchingSince).toBe(now.toISOString())
		expect(afterRepair?.contentWatermarkAt).toBe(repairNow.toISOString())
		expect(afterRepair?.mismatchCount).toBe(0)

		// Equal-timestamp rows after the advanced watermark are both replayed.
		const equalStamp = '2026-08-01T11:15:00.000Z'
		await db
			.prepare(
				`UPDATE email_messages SET updated_at = ? WHERE id IN ('msg-a', 'msg-b')`,
			)
			.bind(equalStamp)
			.run()
		mocks.mirrorMailboxMessageGraphFromD1.mockClear()
		const equalNow = new Date('2026-08-01T12:00:00.000Z')
		vi.setSystemTime(equalNow)
		await expect(
			reconcileMailboxParity({ env, now: equalNow, batchSize: 1 }),
		).resolves.toMatchObject({
			backfilled: 2,
			compared: 1,
			matched: 1,
			failed: 0,
		})
		expect(
			mocks.mirrorMailboxMessageGraphFromD1.mock.calls.map(
				(call) => call[0].messageId as string,
			),
		).toEqual(['msg-a', 'msg-b'])
		expect((await readParityRow(db, owner))?.matchingSince).toBe(
			now.toISOString(),
		)
		expect((await readParityRow(db, owner))?.contentWatermarkAt).toBe(
			equalNow.toISOString(),
		)

		// Failure mid-window: watermark does not advance; matching_since clears.
		await db
			.prepare(
				`UPDATE email_messages
				SET updated_at = '2026-08-01T12:30:00.000Z'
				WHERE id IN ('msg-a', 'msg-b')`,
			)
			.run()
		await db
			.prepare(
				`UPDATE users
				SET mailbox_parity_matching_since = ?
				WHERE stable_user_id = ?`,
			)
			.bind(now.toISOString(), owner)
			.run()
		let contentCalls = 0
		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => {
				contentCalls += 1
				if (contentCalls === 1) {
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
		consoleWarn.mockClear()
		const failNow = new Date('2026-08-01T13:00:00.000Z')
		vi.setSystemTime(failNow)
		await expect(
			reconcileMailboxParity({ env, now: failNow, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 0,
			compared: 0,
			matched: 0,
			mismatched: 0,
			failed: 1,
		})
		expect(consoleWarn).toHaveBeenCalledWith(
			'mailbox-parity-content-replay-retryable',
			owner,
			'error-or-timeout',
		)
		const afterFail = await readParityRow(db, owner)
		expect(afterFail).toMatchObject({
			contentWatermarkAt: equalNow.toISOString(),
			matchingSince: null,
			checkedAt: failNow.toISOString(),
			lastError: 'content replay mirror error or timeout',
			mismatchCount: 0,
		})
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
					// Concurrent classification-like update after the graph mirror.
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

		const env = {
			APP_DB: db,
			MAILBOX: {} as DurableObjectNamespace,
			EMAIL_EVENTS: {
				writeDataPoint: vi.fn(),
			} as unknown as AnalyticsEngineDataset,
		}

		await expect(
			reconcileMailboxParity({ env, now, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 3,
			compared: 1,
			matched: 1,
			mismatched: 0,
			failed: 0,
		})

		const mirroredIds = mocks.mirrorMailboxMessageGraphFromD1.mock.calls.map(
			(call) => call[0].messageId as string,
		)
		expect(mirroredIds).toEqual(['msg-early', 'msg-late', 'msg-early'])
		const after = await readParityRow(db, owner)
		expect(after).toMatchObject({
			matchingSince: now.toISOString(),
			contentWatermarkAt: midUpdateAt.toISOString(),
			mismatchCount: 0,
			messagesCompletedAt: expect.any(String),
			orphanEventsCompletedAt: expect.any(String),
		})
	} finally {
		vi.useRealTimers()
	}
})
