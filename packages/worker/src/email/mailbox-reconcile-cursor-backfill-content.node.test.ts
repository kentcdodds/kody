import {
	countD1MailboxParity,
	createParityDb,
	getMailboxReconcileTestMocks,
	insertEvent,
	insertMessage,
	insertUser,
	listEventBackfillPage,
	listUsersForMailboxParity,
	mockDoCounts,
	mockMirroredEventSnapshots,
	parkUser,
	parityEnv,
	readParityRow,
	reconcileMailboxParity,
	successGraph,
} from '#worker/test-support/mailbox-reconcile.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	mailboxParityContentPageSize,
	mailboxParityEventMirrorTimeoutMs,
	mailboxParityMessagePageSize,
} from './mailbox-parity-phases.ts'

const mocks = getMailboxReconcileTestMocks()

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
	mockMirroredEventSnapshots()
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
	mocks.mirrorMailboxDeliveryEventSnapshots.mockClear()
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
	expect(mocks.mirrorMailboxDeliveryEventSnapshots).toHaveBeenCalledTimes(1)
	expect(mocks.mirrorMailboxDeliveryEventSnapshots).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: ownerA,
			events: expect.arrayContaining([
				expect.objectContaining({ id: 'evt-bound-1' }),
				expect.objectContaining({ id: 'evt-orphan-1' }),
			]),
			timeoutMs: mailboxParityEventMirrorTimeoutMs,
		}),
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
	mocks.mirrorMailboxDeliveryEventSnapshots.mockClear()
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
		mockMirroredEventSnapshots()
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
		mockMirroredEventSnapshots()
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
		mockMirroredEventSnapshots()
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
	mockMirroredEventSnapshots()
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
	expect(mocks.mirrorMailboxDeliveryEventSnapshots).toHaveBeenCalledTimes(1)
	expect(mocks.mirrorMailboxDeliveryEventSnapshots).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: owner,
			events: [
				expect.objectContaining({ id: 'evt-0' }),
				expect.objectContaining({ id: 'evt-1' }),
				expect.objectContaining({ id: 'evt-2' }),
			],
		}),
	)
})
