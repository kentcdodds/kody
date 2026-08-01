import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { systemEmailOwnerId } from '#worker/email/email-owner.ts'
import {
	mailboxReadCutoverCheckedAtMaxAgeMs,
	mailboxReadCutoverSoakMs,
} from '#worker/email/mailbox-read-cutover.ts'
import type * as MailboxClientModule from '#worker/email/mailbox-client.ts'
import type * as MailboxReconcileModule from '#worker/email/mailbox-reconcile.ts'

const mocks = vi.hoisted(() => ({
	reconcileMailboxParity: vi.fn(),
	mailboxRpc: vi.fn(),
}))

vi.mock('#worker/email/mailbox-reconcile.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxReconcileModule>()
	return {
		...actual,
		reconcileMailboxParity: mocks.reconcileMailboxParity,
	}
})

vi.mock('#worker/email/mailbox-client.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxClientModule>()
	return {
		...actual,
		mailboxRpc: mocks.mailboxRpc,
	}
})

const {
	adminMailboxMaintenanceMaxBatchSize,
	loadAdminMailboxMaintenanceStatus,
	runAdminMailboxMaintenanceReconcile,
	runAdminMailboxMaintenanceRetention,
} = await import('./mailbox-maintenance.ts')

const now = new Date('2026-08-01T12:00:00.000Z')

function createMaintenanceDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			deleting_at TEXT,
			mailbox_parity_checked_at TEXT,
			mailbox_parity_matching_since TEXT,
			mailbox_parity_mismatch_count INTEGER NOT NULL DEFAULT 0,
			mailbox_parity_last_error TEXT,
			mailbox_parity_content_watermark_at TEXT,
			mailbox_parity_content_replay_upper_at TEXT,
			mailbox_parity_content_replay_cursor_id TEXT,
			mailbox_parity_message_backfill_cursor_id TEXT,
			mailbox_parity_message_backfill_completed_at TEXT,
			mailbox_parity_event_backfill_cursor_id TEXT,
			mailbox_parity_event_backfill_completed_at TEXT,
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		CREATE TABLE email_messages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL
		);
		CREATE TABLE email_delivery_events (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL
		);
	`)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function insertTrackedUser(
	sqlite: DatabaseSync,
	input: {
		email: string
		checkedAt?: string | null
		matchingSince?: string | null
		mismatchCount?: number
		lastError?: string | null
		messagesCompletedAt?: string | null
		eventsCompletedAt?: string | null
		contentReplayUpperAt?: string | null
		deletingAt?: string | null
		stableUserId?: string
	},
) {
	const stableUserId =
		input.stableUserId ?? testStableUserIdFromEmail(input.email)
	sqlite
		.prepare(
			`INSERT INTO users (
				stable_user_id, username, email, deleting_at,
				mailbox_parity_checked_at, mailbox_parity_matching_since,
				mailbox_parity_mismatch_count, mailbox_parity_last_error,
				mailbox_parity_message_backfill_completed_at,
				mailbox_parity_event_backfill_completed_at,
				mailbox_parity_content_replay_upper_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			stableUserId,
			input.email.split('@')[0] ?? 'user',
			input.email,
			input.deletingAt ?? null,
			input.checkedAt ?? null,
			input.matchingSince ?? null,
			input.mismatchCount ?? 0,
			input.lastError ?? null,
			input.messagesCompletedAt ?? null,
			input.eventsCompletedAt ?? null,
			input.contentReplayUpperAt ?? null,
		)
	return stableUserId
}

test('loadAdminMailboxMaintenanceStatus aggregates buckets without owner ids', async () => {
	const { sqlite, db } = createMaintenanceDb()
	const matchingSince = new Date(
		now.getTime() - mailboxReadCutoverSoakMs - 60_000,
	).toISOString()
	const freshCheckedAt = new Date(
		now.getTime() - mailboxReadCutoverCheckedAtMaxAgeMs / 2,
	).toISOString()
	const incompleteCheckedAt = '2026-07-01T00:00:00.000Z'

	insertTrackedUser(sqlite, {
		email: 'matching@example.com',
		matchingSince,
		checkedAt: freshCheckedAt,
		messagesCompletedAt: matchingSince,
		eventsCompletedAt: matchingSince,
	})
	insertTrackedUser(sqlite, {
		email: 'mismatch@example.com',
		checkedAt: incompleteCheckedAt,
		mismatchCount: 2,
	})
	insertTrackedUser(sqlite, {
		email: 'error@example.com',
		checkedAt: incompleteCheckedAt,
		lastError: 'countMailbox timed out',
	})
	insertTrackedUser(sqlite, {
		email: 'incomplete@example.com',
		checkedAt: incompleteCheckedAt,
		messagesCompletedAt: null,
	})
	insertTrackedUser(sqlite, {
		email: 'deleting@example.com',
		checkedAt: freshCheckedAt,
		matchingSince,
		deletingAt: now.toISOString(),
		messagesCompletedAt: matchingSince,
		eventsCompletedAt: matchingSince,
	})
	insertTrackedUser(sqlite, {
		email: 'system@example.com',
		stableUserId: systemEmailOwnerId,
		checkedAt: freshCheckedAt,
		matchingSince,
		messagesCompletedAt: matchingSince,
		eventsCompletedAt: matchingSince,
	})

	const status = await loadAdminMailboxMaintenanceStatus({ db, now })
	expect(status).toMatchObject({
		generatedAt: now.toISOString(),
		trackedOwners: 4,
		matching: 1,
		mismatch: 1,
		error: 1,
		incomplete: 1,
		eligible: 1,
		oldestMatchingSince: matchingSince,
		newestMatchingSince: matchingSince,
		earliestCutoverAt: new Date(
			Date.parse(matchingSince) + mailboxReadCutoverSoakMs,
		).toISOString(),
	})
	const serialized = JSON.stringify(status)
	expect(serialized).not.toContain('matching@example.com')
	expect(serialized).not.toContain(systemEmailOwnerId)
	expect(serialized).not.toContain('countMailbox timed out')
})

test('runAdminMailboxMaintenanceReconcile clamps batch_size and returns status', async () => {
	const { db } = createMaintenanceDb()
	mocks.reconcileMailboxParity.mockResolvedValue({
		scanned: 1,
		backfilled: 0,
		compared: 1,
		matched: 1,
		mismatched: 0,
		failed: 0,
	})
	const env = { APP_DB: db, MAILBOX: {} } as unknown as Env
	const result = await runAdminMailboxMaintenanceReconcile({
		env,
		batchSize: 10_000,
		now,
	})
	expect(mocks.reconcileMailboxParity).toHaveBeenCalledWith({
		env,
		now,
		batchSize: adminMailboxMaintenanceMaxBatchSize,
	})
	expect(result.metrics.matched).toBe(1)
	expect(result.status.trackedOwners).toBe(0)
})

test('runAdminMailboxMaintenanceRetention aggregates owner results without ids', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createMaintenanceDb()
	const ownerA = insertTrackedUser(sqlite, {
		email: 'ret-a@example.com',
		checkedAt: '2026-07-01T00:00:00.000Z',
	})
	const ownerB = insertTrackedUser(sqlite, {
		email: 'ret-b@example.com',
		checkedAt: '2026-07-02T00:00:00.000Z',
	})
	sqlite
		.prepare(`INSERT INTO email_messages (id, user_id) VALUES (?, ?)`)
		.run('m1', ownerA)
	sqlite
		.prepare(`INSERT INTO email_messages (id, user_id) VALUES (?, ?)`)
		.run('m2', ownerB)

	const runRetentionNow = vi
		.fn()
		.mockResolvedValueOnce({
			before: {
				threads: 1,
				messages: 2,
				attachments: 1,
				deliveryEvents: 3,
			},
			after: {
				threads: 0,
				messages: 1,
				attachments: 0,
				deliveryEvents: 1,
			},
			blobDeleteFailures: true,
			expiredRemaining: true,
		})
		.mockRejectedValueOnce(new Error('mailbox unavailable'))

	mocks.mailboxRpc.mockImplementation(({ userId }: { userId: string }) => {
		expect([ownerA, ownerB]).toContain(userId)
		return { runRetentionNow }
	})

	const result = await runAdminMailboxMaintenanceRetention({
		env: { APP_DB: db, MAILBOX: {} } as unknown as Env,
		batchSize: 10,
		now,
	})

	expect(runRetentionNow).toHaveBeenCalledTimes(2)
	expect(runRetentionNow).toHaveBeenCalledWith({ ownerId: ownerA })
	expect(result.metrics).toEqual({
		ownersAttempted: 2,
		ownersSucceeded: 1,
		ownersFailed: 1,
		messagesDeleted: 1,
		threadsDeleted: 1,
		attachmentsDeleted: 1,
		deliveryEventsDeleted: 2,
		blobDeleteFailureOwners: 1,
		expiredRemainingOwners: 1,
	})
	const serialized = JSON.stringify(result)
	expect(serialized).not.toContain(ownerA)
	expect(serialized).not.toContain(ownerB)
	expect(serialized).not.toContain('mailbox unavailable')
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-mailbox-maintenance-retention-owner-failed',
		expect.objectContaining({ error: expect.any(Error) }),
	)
})
