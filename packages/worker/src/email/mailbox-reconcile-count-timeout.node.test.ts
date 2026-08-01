import {
	createParityDb,
	getMailboxReconcileTestMocks,
	insertEvent,
	insertMessage,
	insertUser,
	mockDoCounts,
	mockMirroredEventSnapshots,
	parityEnv,
	readParityRow,
	reconcileMailboxParity,
	successGraph,
} from '#worker/test-support/mailbox-reconcile.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	awaitMailboxMirrorRpc,
	mailboxMirrorRpcTimeoutMs,
} from './mailbox-mirror.ts'
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

test('count compare uses ~5s timeout so a count that exceeds 1s can still succeed', async () => {
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
})

test('count compare timeout clears soak and retries on the next tick', async () => {
	consoleWarn.mockImplementation(() => {})
	const { db } = await createParityDb()
	const owner = 'o'.repeat(64)
	const now = new Date('2026-08-01T10:00:00.000Z')
	await seedReadyForCompare(db, owner)

	const counts = {
		threads: 0,
		messages: 1,
		attachments: 0,
		deliveryEvents: 1,
	}
	mockDoCounts(counts)
	const env = parityEnv(db)
	await expect(
		reconcileMailboxParity({ env, now, batchSize: 1 }),
	).resolves.toMatchObject({ matched: 1, compared: 1 })
	const afterMatch = await readParityRow(db, owner)
	expect(afterMatch?.matchingSince).toBe(now.toISOString())

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
