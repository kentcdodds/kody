import {
	createParityDb,
	getMailboxReconcileTestMocks,
	insertEvent,
	insertMessage,
	insertUser,
	listUsersForMailboxParity,
	mockDoCounts,
	parityEnv,
	readParityRow,
	reconcileMailboxParity,
	successGraph,
} from '#worker/test-support/mailbox-reconcile.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = getMailboxReconcileTestMocks()

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
