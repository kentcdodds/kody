import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	backfillEventsForUser,
	mailboxParityEventMirrorTimeoutMs,
} from './mailbox-parity-phases.ts'
import { type MailboxParityUserState } from './mailbox-parity-repo.ts'
import { mailboxMirrorRpcTimeoutMs } from './mailbox-mirror.ts'
import type * as MailboxMirrorModule from './mailbox-mirror.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

const mailboxMirrorMocks = vi.hoisted(() => ({
	mirrorMailboxDeliveryEventSnapshots: vi.fn(),
}))

vi.mock('#worker/email/mailbox-mirror.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxMirrorModule>()
	return {
		...actual,
		mirrorMailboxDeliveryEventSnapshots:
			mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots,
	}
})

async function createPhaseDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureUsersTestSchema({ db })
	await ensureEmailTestSchema(db)
	return db
}

async function seedOwnerWithEvents(input: {
	db: D1Database
	userId: string
	events: Array<{ id: string; createdAt: string }>
}) {
	await input.db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id
			) VALUES (?, ?, 'hash', ?)`,
		)
		.bind(
			`u-${input.userId.slice(0, 8)}`,
			`${input.userId}@example.test`,
			input.userId,
		)
		.run()
	for (const event of input.events) {
		await input.db
			.prepare(
				`INSERT INTO email_delivery_events (
					id, message_id, user_id, event_type, provider, detail_json, created_at
				) VALUES (?, NULL, ?, 'receive_started', 'cloudflare-email-routing', '{}', ?)`,
			)
			.bind(event.id, input.userId, event.createdAt)
			.run()
	}
}

function baseState(userId: string): MailboxParityUserState {
	return {
		userId,
		matchingSince: null,
		mismatchCount: 0,
		contentWatermarkAt: '2026-08-01T10:00:00.000Z',
		contentReplayUpperAt: null,
		contentReplayCursor: null,
		messageCursor: { createdAt: '2026-07-01T00:00:00.000Z', id: 'msg-1' },
		messagesCompletedAt: '2026-08-01T10:00:00.000Z',
		eventCursor: null,
		eventsCompletedAt: null,
	}
}

function phaseEnv(db: D1Database) {
	return {
		APP_DB: db,
		MAILBOX: {} as DurableObjectNamespace,
		EMAIL_EVENTS: {
			writeDataPoint: vi.fn(),
		} as unknown as AnalyticsEngineDataset,
	}
}

test('event backfill mirrors one page with one batch RPC under the scheduled timeout', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = await createPhaseDb()
	const userId = 'a'.repeat(64)
	const events = Array.from({ length: 3 }, (_, index) => ({
		id: `evt-${index}`,
		createdAt: `2026-07-01T00:00:0${index}.000Z`,
	}))
	await seedOwnerWithEvents({ db, userId, events })

	mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots.mockImplementation(
		async (input: { events: Array<{ id: string }>; timeoutMs?: number }) =>
			input.events.map((event) => ({
				eventId: event.id,
				result: { status: 'mirrored' as const },
			})),
	)

	const result = await backfillEventsForUser({
		env: phaseEnv(db),
		state: baseState(userId),
		deadlineMs: Date.now() + 10_000,
		isDeleting: async () => false,
	})

	expect(result).toMatchObject({
		status: 'complete',
		backfilled: 3,
		state: { eventCursor: { id: 'evt-2' } },
	})
	expect(
		mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots,
	).toHaveBeenCalledTimes(1)
	expect(
		mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			ownerId: userId,
			timeoutMs: mailboxParityEventMirrorTimeoutMs,
			events: [
				expect.objectContaining({ id: 'evt-0' }),
				expect.objectContaining({ id: 'evt-1' }),
				expect.objectContaining({ id: 'evt-2' }),
			],
		}),
	)
})

test('event backfill keeps cursor on uniform timeout and advances through partial stale', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = await createPhaseDb()
	const userId = 'b'.repeat(64)
	await seedOwnerWithEvents({
		db,
		userId,
		events: [
			{ id: 'evt-a', createdAt: '2026-07-01T00:00:00.000Z' },
			{ id: 'evt-b', createdAt: '2026-07-01T00:00:01.000Z' },
			{ id: 'evt-c', createdAt: '2026-07-01T00:00:02.000Z' },
		],
	})

	mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots.mockResolvedValueOnce([
		{ eventId: 'evt-a', result: { status: 'timeout' } },
		{ eventId: 'evt-b', result: { status: 'timeout' } },
		{ eventId: 'evt-c', result: { status: 'timeout' } },
	])

	const timedOut = await backfillEventsForUser({
		env: phaseEnv(db),
		state: baseState(userId),
		deadlineMs: Date.now() + 10_000,
		isDeleting: async () => false,
	})
	expect(timedOut).toEqual({
		status: 'retryable_failure',
		backfilled: 0,
		blockedReason: 'event timeout',
		state: expect.objectContaining({
			eventCursor: null,
			eventsCompletedAt: null,
		}),
	})

	mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots.mockResolvedValueOnce([
		{ eventId: 'evt-a', result: { status: 'stale' } },
		{ eventId: 'evt-b', result: { status: 'mirrored' } },
		{ eventId: 'evt-c', result: { status: 'missing' } },
	])
	const advanced = await backfillEventsForUser({
		env: phaseEnv(db),
		state: timedOut.state,
		deadlineMs: Date.now() + 10_000,
		isDeleting: async () => false,
	})
	expect(advanced).toMatchObject({
		status: 'complete',
		backfilled: 3,
		state: {
			eventCursor: {
				createdAt: '2026-07-01T00:00:02.000Z',
				id: 'evt-c',
			},
			eventsCompletedAt: expect.any(String),
		},
	})
})

test('event backfill progresses equal createdAt timestamps by id keyset', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = await createPhaseDb()
	const userId = 'c'.repeat(64)
	const sameAt = '2026-07-01T00:00:00.000Z'
	await seedOwnerWithEvents({
		db,
		userId,
		events: [
			{ id: 'evt-a', createdAt: sameAt },
			{ id: 'evt-b', createdAt: sameAt },
			{ id: 'evt-c', createdAt: sameAt },
			{ id: 'evt-d', createdAt: '2026-07-01T00:00:01.000Z' },
		],
	})

	const seenPages: Array<Array<string>> = []
	mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots.mockImplementation(
		async (input: { events: Array<{ id: string }> }) => {
			seenPages.push(input.events.map((event) => event.id))
			return input.events.map((event) => ({
				eventId: event.id,
				result: { status: 'mirrored' as const },
			}))
		},
	)

	const firstPage = await backfillEventsForUser({
		env: phaseEnv(db),
		state: {
			...baseState(userId),
			eventCursor: null,
		},
		deadlineMs: Date.now() + 10_000,
		isDeleting: async () => false,
	})
	expect(seenPages[0]).toEqual(['evt-a', 'evt-b', 'evt-c', 'evt-d'])
	expect(firstPage).toMatchObject({
		status: 'complete',
		backfilled: 4,
		state: {
			eventCursor: { createdAt: '2026-07-01T00:00:01.000Z', id: 'evt-d' },
		},
	})

	seenPages.length = 0
	mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots.mockImplementation(
		async (input: { events: Array<{ id: string }> }) => {
			seenPages.push(input.events.map((event) => event.id))
			// Fail after the first equal-timestamp event so the next tick resumes
			// at evt-b (same createdAt, greater id).
			return input.events.map((event, index) => ({
				eventId: event.id,
				result:
					index === 0
						? { status: 'mirrored' as const }
						: { status: 'timeout' as const },
			}))
		},
	)
	const partial = await backfillEventsForUser({
		env: phaseEnv(db),
		state: {
			...baseState(userId),
			eventCursor: null,
			eventsCompletedAt: null,
		},
		deadlineMs: Date.now() + 10_000,
		isDeleting: async () => false,
	})
	expect(partial).toMatchObject({
		status: 'retryable_failure',
		backfilled: 1,
		blockedReason: 'event timeout',
		state: {
			eventCursor: { createdAt: sameAt, id: 'evt-a' },
		},
	})

	seenPages.length = 0
	mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots.mockImplementation(
		async (input: { events: Array<{ id: string }> }) => {
			seenPages.push(input.events.map((event) => event.id))
			return input.events.map((event) => ({
				eventId: event.id,
				result: { status: 'mirrored' as const },
			}))
		},
	)
	const resumed = await backfillEventsForUser({
		env: phaseEnv(db),
		state: partial.state,
		deadlineMs: Date.now() + 10_000,
		isDeleting: async () => false,
	})
	expect(seenPages[0]).toEqual(['evt-b', 'evt-c', 'evt-d'])
	expect(resumed).toMatchObject({
		status: 'complete',
		backfilled: 3,
		state: {
			eventCursor: { createdAt: '2026-07-01T00:00:01.000Z', id: 'evt-d' },
		},
	})
})

test('event backfill uses ~5s batch timeout so a page that exceeds 1s can still succeed', async () => {
	consoleWarn.mockImplementation(() => {})
	const db = await createPhaseDb()
	const userId = 'd'.repeat(64)
	await seedOwnerWithEvents({
		db,
		userId,
		events: [{ id: 'evt-slow', createdAt: '2026-07-01T00:00:00.000Z' }],
	})

	const slowRpcMs = mailboxMirrorRpcTimeoutMs + 500
	expect(slowRpcMs).toBeGreaterThan(mailboxMirrorRpcTimeoutMs)
	expect(slowRpcMs).toBeLessThan(mailboxParityEventMirrorTimeoutMs)

	mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots.mockImplementation(
		async (input: { timeoutMs?: number; events: Array<{ id: string }> }) => {
			const timeoutMs = input.timeoutMs ?? mailboxMirrorRpcTimeoutMs
			return input.events.map((event) => ({
				eventId: event.id,
				result:
					slowRpcMs > timeoutMs
						? { status: 'timeout' as const }
						: { status: 'mirrored' as const },
			}))
		},
	)

	const liveBoundProbe =
		await mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots({
			env: phaseEnv(db),
			ownerId: userId,
			events: [{ id: 'evt-slow' }],
			timeoutMs: mailboxMirrorRpcTimeoutMs,
		})
	expect(liveBoundProbe).toEqual([
		{ eventId: 'evt-slow', result: { status: 'timeout' } },
	])

	const result = await backfillEventsForUser({
		env: phaseEnv(db),
		state: baseState(userId),
		deadlineMs: Date.now() + 10_000,
		isDeleting: async () => false,
	})
	expect(result).toMatchObject({
		status: 'complete',
		backfilled: 1,
	})
	expect(
		mailboxMirrorMocks.mirrorMailboxDeliveryEventSnapshots,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			timeoutMs: mailboxParityEventMirrorTimeoutMs,
		}),
	)
})
