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
	awaitMailboxMirrorRpc,
	mailboxMirrorRpcTimeoutMs,
} from './mailbox-mirror.ts'
import {
	mailboxParityContentPageSize,
	mailboxParityEventMirrorTimeoutMs,
	mailboxParityMessagePageSize,
} from './mailbox-parity-phases.ts'
import { mailboxParityCountTimeoutMs } from './mailbox-reconcile.ts'

const mocks = getMailboxReconcileTestMocks()

function isMailboxCountResult(value: unknown): value is {
	threads: number
	messages: number
	attachments: number
	deliveryEvents: number
} {
	return (
		value != null &&
		typeof value === 'object' &&
		'threads' in value &&
		'messages' in value &&
		'attachments' in value &&
		'deliveryEvents' in value
	)
}

async function seedReadyForCompare(db: D1Database, owner: string) {
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
		id: 'evt-1',
		messageId: 'msg-1',
		createdAt: '2026-07-01T00:00:01.000Z',
	})
	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
		async (input: { messageId: string }) => successGraph(input.messageId),
	)
	mockMirroredEventSnapshots()
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
	expect(
		Date.parse(afterSoak?.contentWatermarkAt ?? '') >= soakNow.getTime(),
	).toBe(true)
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

test('mailbox parity content watermark repair, mid-backfill replay, durable resume, and eventsTruncated', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.useFakeTimers()
	const now = new Date('2026-08-01T10:00:00.000Z')

	try {
		// Equal-count content updates advance the watermark without clearing soak.
		vi.setSystemTime(now)
		const repairDb = await createParityDb()
		const repairOwner = 'd'.repeat(64)
		await insertUser({ db: repairDb.db, userId: repairOwner, checkedAt: null })
		await insertMessage({
			db: repairDb.db,
			userId: repairOwner,
			id: 'msg-a',
			createdAt: '2026-07-01T00:00:00.000Z',
		})
		await insertMessage({
			db: repairDb.db,
			userId: repairOwner,
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
		const repairEnv = parityEnv(repairDb.db)
		await expect(
			reconcileMailboxParity({ env: repairEnv, now, batchSize: 1 }),
		).resolves.toMatchObject({ matched: 1, compared: 1 })
		expect(
			(await readParityRow(repairDb.db, repairOwner))?.contentWatermarkAt,
		).toBe(now.toISOString())

		const sharedUpdatedAt = '2026-08-01T10:30:00.000Z'
		await repairDb.db
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
			reconcileMailboxParity({ env: repairEnv, now: repairNow, batchSize: 1 }),
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
		const afterRepair = await readParityRow(repairDb.db, repairOwner)
		expect(afterRepair?.matchingSince).toBe(now.toISOString())
		expect(afterRepair?.contentWatermarkAt).toBe(repairNow.toISOString())
		expect(afterRepair?.contentReplayUpperAt).toBeNull()

		// Message updated during initial backfill is replayed before compare.
		vi.setSystemTime(now)
		const midDb = await createParityDb()
		const midOwner = 'e'.repeat(64)
		const midUpdateAt = new Date('2026-08-01T10:00:05.000Z')
		await insertUser({ db: midDb.db, userId: midOwner, checkedAt: null })
		await insertMessage({
			db: midDb.db,
			userId: midOwner,
			id: 'msg-early',
			createdAt: '2026-07-01T00:00:00.000Z',
		})
		await insertMessage({
			db: midDb.db,
			userId: midOwner,
			id: 'msg-late',
			createdAt: '2026-07-01T00:00:01.000Z',
		})
		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => {
				if (input.messageId === 'msg-early') {
					vi.setSystemTime(midUpdateAt)
					await midDb.db
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
		mocks.mirrorMailboxMessageGraphFromD1.mockClear()
		await expect(
			reconcileMailboxParity({
				env: parityEnv(midDb.db),
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
		expect((await readParityRow(midDb.db, midOwner))?.contentWatermarkAt).toBe(
			midUpdateAt.toISOString(),
		)

		// Content replay persists upper bound + cursor across budget-exhausted ticks.
		const resumeDb = await createParityDb()
		const resumeOwner = 'f'.repeat(64)
		const baseline = new Date('2026-08-01T10:00:00.000Z')
		vi.setSystemTime(baseline)
		await insertUser({ db: resumeDb.db, userId: resumeOwner, checkedAt: null })
		const messageCount = mailboxParityContentPageSize + 2
		for (let index = 0; index < messageCount; index += 1) {
			await insertMessage({
				db: resumeDb.db,
				userId: resumeOwner,
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
		const resumeEnv = parityEnv(resumeDb.db)
		await reconcileMailboxParity({
			env: resumeEnv,
			now: baseline,
			batchSize: 1,
		})

		const updateAt = '2026-08-01T10:30:00.000Z'
		await resumeDb.db
			.prepare(`UPDATE email_messages SET updated_at = ? WHERE user_id = ?`)
			.bind(updateAt, resumeOwner)
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
			reconcileMailboxParity({ env: resumeEnv, now: replayNow, batchSize: 1 }),
		).resolves.toMatchObject({
			compared: 0,
			failed: 0,
			backfilled: mailboxParityContentPageSize,
		})
		const mid = await readParityRow(resumeDb.db, resumeOwner)
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
			reconcileMailboxParity({ env: resumeEnv, now: replayNow, batchSize: 1 }),
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
		const done = await readParityRow(resumeDb.db, resumeOwner)
		expect(done).toMatchObject({
			contentWatermarkAt: replayNow.toISOString(),
			contentReplayUpperAt: null,
			contentReplayCursorId: null,
			// Soak was cleared on the incomplete tick; exact compare starts a new window.
			matchingSince: replayNow.toISOString(),
		})

		// Truncated message-graph events still complete via the full event phase.
		vi.setSystemTime(now)
		const truncatedDb = await createParityDb()
		const truncatedOwner = 'h'.repeat(64)
		await insertUser({
			db: truncatedDb.db,
			userId: truncatedOwner,
			checkedAt: null,
		})
		await insertMessage({
			db: truncatedDb.db,
			userId: truncatedOwner,
			id: 'msg-1',
			createdAt: '2026-07-01T00:00:00.000Z',
		})
		for (let index = 0; index < 3; index += 1) {
			await insertEvent({
				db: truncatedDb.db,
				userId: truncatedOwner,
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
		mocks.mirrorMailboxDeliveryEventSnapshots.mockClear()
		await expect(
			reconcileMailboxParity({
				env: parityEnv(truncatedDb.db),
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
				ownerId: truncatedOwner,
				events: [
					expect.objectContaining({ id: 'evt-0' }),
					expect.objectContaining({ id: 'evt-1' }),
					expect.objectContaining({ id: 'evt-2' }),
				],
			}),
		)
	} finally {
		vi.useRealTimers()
	}
})

test('count compare allows slow DO counts, then timeout clears soak and retries', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const owner = 'n'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	await seedReadyForCompare(db, owner)

	const slowRpcMs = mailboxMirrorRpcTimeoutMs + 500
	expect(slowRpcMs).toBeGreaterThan(mailboxMirrorRpcTimeoutMs)
	expect(slowRpcMs).toBeLessThan(mailboxParityCountTimeoutMs)

	const counts = {
		threads: 0,
		messages: 1,
		attachments: 0,
		deliveryEvents: 1,
	}
	mocks.mailboxRpc.mockImplementation(() => ({
		countMailbox: vi.fn(async () => counts),
		purge: vi.fn(async () => ({ ok: true as const })),
		purgeForParityRebuild: vi.fn(async () => ({ ok: true as const })),
	}))
	mocks.awaitMailboxMirrorRpc.mockImplementation(
		async (promise: Promise<unknown>, timeoutMs?: number) => {
			const timeout = timeoutMs ?? mailboxMirrorRpcTimeoutMs
			const value = await promise
			if (isMailboxCountResult(value) && slowRpcMs > timeout) {
				return { ok: false as const, timedOut: true as const }
			}
			return { ok: true as const, value }
		},
	)

	const liveBoundProbe = await awaitMailboxMirrorRpc(
		Promise.resolve(counts),
		mailboxMirrorRpcTimeoutMs,
	)
	expect(liveBoundProbe).toEqual({ ok: false, timedOut: true })

	const env = parityEnv(db)
	await expect(
		reconcileMailboxParity({ env, now, batchSize: 1 }),
	).resolves.toMatchObject({
		scanned: 1,
		compared: 1,
		matched: 1,
		mismatched: 0,
		failed: 0,
	})
	expect(mocks.awaitMailboxMirrorRpc).toHaveBeenCalledWith(
		expect.any(Promise),
		mailboxParityCountTimeoutMs,
	)
	const afterMatch = await readParityRow(db, owner)
	expect(afterMatch?.matchingSince).toBe(now.toISOString())

	// Count timeout on a later tick clears soak and allows a clean retry.
	mocks.awaitMailboxMirrorRpc.mockImplementation(
		async (promise: Promise<unknown>, timeoutMs?: number) => {
			const value = await promise
			if (isMailboxCountResult(value)) {
				const timeout = timeoutMs ?? mailboxMirrorRpcTimeoutMs
				if (timeout >= mailboxParityCountTimeoutMs) {
					return { ok: false as const, timedOut: true as const }
				}
			}
			return { ok: true as const, value }
		},
	)
	consoleWarn.mockClear()
	const timeoutNow = new Date('2026-08-01T11:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: timeoutNow, batchSize: 1 }),
	).resolves.toEqual({
		scanned: 1,
		backfilled: 0,
		compared: 0,
		matched: 0,
		mismatched: 0,
		failed: 1,
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'mailbox-parity-reconcile-user-failed',
		owner,
		expect.any(Error),
	)
	const afterTimeout = await readParityRow(db, owner)
	expect(afterTimeout).toMatchObject({
		matchingSince: null,
		lastError: 'Mailbox countMailbox timed out',
		checkedAt: timeoutNow.toISOString(),
	})

	mocks.awaitMailboxMirrorRpc.mockImplementation(
		async (promise: Promise<unknown>) => ({
			ok: true as const,
			value: await promise,
		}),
	)
	const retryNow = new Date('2026-08-01T12:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: retryNow, batchSize: 1 }),
	).resolves.toMatchObject({ matched: 1, compared: 1, failed: 0 })
	const afterRetry = await readParityRow(db, owner)
	expect(afterRetry).toMatchObject({
		matchingSince: retryNow.toISOString(),
		lastError: null,
		mismatchCount: 0,
	})
})

test('mailbox parity missing/unconfigured and event-missing cursor rules', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const now = new Date('2026-08-01T10:00:00.000Z')
	const env = parityEnv(db)

	// Message missing / event unconfigured must not advance creation cursors.
	const cursorOwner = 'g'.repeat(64)
	await insertUser({ db, userId: cursorOwner, checkedAt: null })
	await insertMessage({
		db,
		userId: cursorOwner,
		id: 'msg-1',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	await insertMessage({
		db,
		userId: cursorOwner,
		id: 'msg-2',
		createdAt: '2026-07-01T00:00:01.000Z',
	})
	await insertEvent({
		db,
		userId: cursorOwner,
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
	mockMirroredEventSnapshots()
	mockDoCounts({
		threads: 0,
		messages: 2,
		attachments: 0,
		deliveryEvents: 1,
	})
	await expect(
		reconcileMailboxParity({ env, now, batchSize: 1 }),
	).resolves.toMatchObject({ failed: 1, backfilled: 0, compared: 0 })
	expect(await readParityRow(db, cursorOwner)).toMatchObject({
		messageCursorId: null,
		messagesCompletedAt: null,
		contentWatermarkAt: now.toISOString(),
		lastError: 'message backfill message graph missing',
	})

	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
		async (input: { messageId: string }) => successGraph(input.messageId),
	)
	mocks.mirrorMailboxDeliveryEventSnapshots.mockImplementationOnce(
		async (input: { events: Array<{ id: string }> }) =>
			input.events.map((event) => ({
				eventId: event.id,
				result: {
					status: 'skipped' as const,
					reason: 'mailbox-unconfigured' as const,
				},
			})),
	)
	await expect(
		reconcileMailboxParity({
			env,
			now: new Date('2026-08-01T11:00:00.000Z'),
			batchSize: 1,
		}),
	).resolves.toMatchObject({ failed: 1, compared: 0 })
	expect(await readParityRow(db, cursorOwner)).toMatchObject({
		messagesCompletedAt: expect.any(String),
		eventCursorId: null,
		eventsCompletedAt: null,
		lastError: 'event backfill event skipped:mailbox-unconfigured',
	})

	// Event missing advances the cursor; compare can still succeed.
	const eventOwner = 'j'.repeat(64)
	await insertUser({ db, userId: eventOwner, checkedAt: null })
	await insertMessage({
		db,
		userId: eventOwner,
		id: 'evt-owner-msg',
		createdAt: '2026-07-01T00:00:00.000Z',
	})
	await insertEvent({
		db,
		userId: eventOwner,
		id: 'evt-gone',
		messageId: 'evt-owner-msg',
		createdAt: '2026-07-01T00:00:01.000Z',
	})
	await insertEvent({
		db,
		userId: eventOwner,
		id: 'evt-ok',
		messageId: 'evt-owner-msg',
		createdAt: '2026-07-01T00:00:02.000Z',
	})
	await parkUser(db, cursorOwner)
	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
		async (input: { messageId: string }) => successGraph(input.messageId),
	)
	mocks.mirrorMailboxDeliveryEventSnapshots.mockImplementationOnce(
		async (input: { events: Array<{ id: string }> }) =>
			input.events.map((event) => ({
				eventId: event.id,
				result:
					event.id === 'evt-gone'
						? { status: 'missing' as const }
						: { status: 'mirrored' as const },
			})),
	)
	mockDoCounts({
		threads: 0,
		messages: 1,
		attachments: 0,
		deliveryEvents: 2,
	})
	await expect(
		reconcileMailboxParity({ env, now, batchSize: 1 }),
	).resolves.toMatchObject({ matched: 1, failed: 0 })
	expect(await readParityRow(db, eventOwner)).toMatchObject({
		eventCursorId: 'evt-ok',
		eventsCompletedAt: expect.any(String),
	})
})

test('mailbox parity deletion race and mismatch purge failure', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const env = parityEnv(db)
	const now = new Date('2026-08-01T10:00:00.000Z')

	// Deletion mid-backfill purges Mailbox and skips parity completion writes.
	const deletingOwner = 'i'.repeat(64)
	await insertUser({ db, userId: deletingOwner, checkedAt: null })
	await insertMessage({
		db,
		userId: deletingOwner,
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
			.bind(now.toISOString(), deletingOwner)
			.run()
		return successGraph('msg-1')
	})
	mockMirroredEventSnapshots()
	await expect(
		reconcileMailboxParity({ env, now, batchSize: 1 }),
	).resolves.toEqual({
		scanned: 1,
		backfilled: 0,
		compared: 0,
		matched: 0,
		mismatched: 0,
		failed: 0,
	})
	expect(purge).toHaveBeenCalledTimes(1)
	const deletedRow = await readParityRow(db, deletingOwner)
	// Baseline may have been written before deletion; no completion/compare state.
	expect(deletedRow?.messagesCompletedAt).toBeNull()
	expect(deletedRow?.matchingSince).toBeNull()
	expect(deletedRow?.eventsCompletedAt).toBeNull()

	// Mismatch purge failure clears soak without starting a rebuild reset.
	vi.useFakeTimers()
	try {
		const purgeFailOwner = 'm'.repeat(64)
		vi.setSystemTime(now)
		await insertUser({ db, userId: purgeFailOwner, checkedAt: null })
		await insertMessage({
			db,
			userId: purgeFailOwner,
			id: 'purge-msg-1',
			createdAt: '2026-07-01T00:00:00.000Z',
		})
		mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(
			async (input: { messageId: string }) => successGraph(input.messageId),
		)
		mockMirroredEventSnapshots()
		mockDoCounts({
			threads: 0,
			messages: 1,
			attachments: 0,
			deliveryEvents: 0,
		})
		await expect(
			reconcileMailboxParity({ env, now, batchSize: 1 }),
		).resolves.toMatchObject({ matched: 1 })
		const afterMatch = await readParityRow(db, purgeFailOwner)
		expect(afterMatch?.messagesCompletedAt).toEqual(expect.any(String))
		expect(afterMatch?.contentWatermarkAt).toBe(now.toISOString())

		mocks.mailboxRpc.mockImplementation(() => ({
			countMailbox: vi.fn(async () => ({
				threads: 0,
				messages: 2,
				attachments: 0,
				deliveryEvents: 0,
			})),
			purgeForParityRebuild: vi.fn(async () => ({ ok: true as const })),
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
			purgeFailOwner,
			'timeout',
			'mailbox metadata purge timeout',
		)
		const afterFail = await readParityRow(db, purgeFailOwner)
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
