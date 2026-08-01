import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import {
	countD1MailboxParity,
	reconcileMailboxParity,
} from './mailbox-reconcile.ts'
import { rpcFor } from './mailbox-test-helpers.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

async function seedParityUser(input: {
	email: string
	checkedAt?: string | null
}) {
	const userId = await createStableUserIdFromEmail(input.email)
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username, email, password_hash, plan, stable_user_id,
			mailbox_parity_checked_at
		) VALUES (?, ?, 'test-password-hash', 'max', ?, ?)`,
	)
		.bind(
			`parity-${crypto.randomUUID().slice(0, 8)}`,
			input.email,
			userId,
			input.checkedAt ?? null,
		)
		.run()
	return userId
}

async function seedMessageGraph(input: {
	userId: string
	messageId: string
	threadId: string
	createdAt: string
	withAttachment?: boolean
}) {
	await env.APP_DB.prepare(
		`INSERT INTO email_threads (
			id, user_id, subject_normalized, last_message_at, created_at, updated_at
		) VALUES (?, ?, 'hello', ?, ?, ?)`,
	)
		.bind(
			input.threadId,
			input.userId,
			input.createdAt,
			input.createdAt,
			input.createdAt,
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, thread_id, from_address, subject, text_body,
			raw_size, processing_status, created_at, updated_at
		) VALUES (?, 'outbound', ?, ?, 'from@example.test', 'Hello', 'body', 4,
			'sent', ?, ?)`,
	)
		.bind(
			input.messageId,
			input.userId,
			input.threadId,
			input.createdAt,
			input.createdAt,
		)
		.run()
	if (input.withAttachment) {
		await env.APP_DB.prepare(
			`INSERT INTO email_attachments (
				id, message_id, filename, content_type, size, storage_kind, created_at
			) VALUES (?, ?, 'note.txt', 'text/plain', 4, 'unavailable', ?)`,
		)
			.bind(`att-${input.messageId}`, input.messageId, input.createdAt)
			.run()
	}
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, message_id, user_id, event_type, provider, detail_json, created_at
		) VALUES (?, ?, ?, 'sent', 'kody', '{}', ?)`,
	)
		.bind(
			`evt-${input.messageId}`,
			input.messageId,
			input.userId,
			input.createdAt,
		)
		.run()
}

async function seedOrphanEvent(input: {
	userId: string
	eventId: string
	createdAt: string
}) {
	await env.APP_DB.prepare(
		`INSERT INTO email_delivery_events (
			id, message_id, user_id, event_type, provider, detail_json, created_at
		) VALUES (?, NULL, ?, 'receive_started', 'cloudflare-email-routing', '{}', ?)`,
	)
		.bind(input.eventId, input.userId, input.createdAt)
		.run()
}

async function readParityState(userId: string) {
	return env.APP_DB.prepare(
		`SELECT
			mailbox_parity_checked_at AS checkedAt,
			mailbox_parity_matching_since AS matchingSince,
			mailbox_parity_mismatch_count AS mismatchCount,
			mailbox_parity_content_watermark_at AS contentWatermarkAt,
			mailbox_parity_message_backfill_cursor_id AS messageCursorId,
			mailbox_parity_message_backfill_completed_at AS messagesCompletedAt,
			mailbox_parity_orphan_event_backfill_cursor_id AS orphanCursorId,
			mailbox_parity_orphan_event_backfill_completed_at AS orphanEventsCompletedAt,
			mailbox_parity_last_error AS lastError
		FROM users
		WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.first<{
			checkedAt: string | null
			matchingSince: string | null
			mismatchCount: number
			contentWatermarkAt: string | null
			messageCursorId: string | null
			messagesCompletedAt: string | null
			orphanCursorId: string | null
			orphanEventsCompletedAt: string | null
			lastError: string | null
		}>()
}

async function parkOther(userId: string) {
	await env.APP_DB.prepare(
		`UPDATE users
		SET mailbox_parity_checked_at = '9999-12-31T23:59:59.999Z'
		WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.run()
}

test('reconcileMailboxParity mismatch reopens backfill, resets count, preserves soak', async () => {
	silenceIncidentalRuntimeWarnings()
	// Keep wall time aligned with each tick's nowIso so same-run content upper
	// bounds stay deterministic (without freezing RPC timeout clocks).
	vi.useFakeTimers({ shouldAdvanceTime: true })
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureEmailTestSchema(env.APP_DB)

	try {
		await env.APP_DB.prepare(
			`UPDATE users
			SET mailbox_parity_checked_at = '9999-12-31T23:59:59.999Z'`,
		).run()

		const userId = await seedParityUser({
			email: `parity-${crypto.randomUUID()}@example.test`,
			checkedAt: null,
		})
		const otherUserId = await seedParityUser({
			email: `other-${crypto.randomUUID()}@example.test`,
			checkedAt: '9999-12-31T23:59:59.999Z',
		})

		await seedMessageGraph({
			userId,
			messageId: 'parity-msg-1',
			threadId: 'parity-thread-1',
			createdAt: '2026-07-01T12:00:00.000Z',
			withAttachment: true,
		})
		await seedMessageGraph({
			userId,
			messageId: 'parity-msg-2',
			threadId: 'parity-thread-2',
			createdAt: '2026-07-01T12:01:00.000Z',
		})
		await seedOrphanEvent({
			userId,
			eventId: 'parity-orphan-1',
			createdAt: '2026-07-01T12:02:00.000Z',
		})
		await seedMessageGraph({
			userId: otherUserId,
			messageId: 'other-msg-1',
			threadId: 'other-thread-1',
			createdAt: '2026-07-01T12:00:00.000Z',
		})

		const mailbox = rpcFor(userId)
		// Warm the DO so the first 1s-bounded mirror RPC is not cold-start timeout.
		await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

		const firstNow = new Date('2026-08-01T10:00:00.000Z')
		vi.setSystemTime(firstNow)
		await expect(
			reconcileMailboxParity({ env, now: firstNow, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 3,
			compared: 1,
			matched: 1,
			mismatched: 0,
			failed: 0,
		})

		const d1Counts = await countD1MailboxParity({ db: env.APP_DB, userId })
		expect(await mailbox.countMailbox()).toEqual(d1Counts)
		expect(await mailbox.getMessage({ messageId: 'other-msg-1' })).toBeNull()

		const afterMatch = await readParityState(userId)
		expect(afterMatch).toMatchObject({
			checkedAt: firstNow.toISOString(),
			matchingSince: firstNow.toISOString(),
			contentWatermarkAt: expect.any(String),
			mismatchCount: 0,
			messagesCompletedAt: expect.any(String),
			orphanEventsCompletedAt: expect.any(String),
			messageCursorId: 'parity-msg-2',
			orphanCursorId: 'parity-orphan-1',
			lastError: null,
		})
		if (!afterMatch?.contentWatermarkAt) {
			throw new Error('Expected parity content watermark after match.')
		}
		expect(afterMatch.contentWatermarkAt >= firstNow.toISOString()).toBe(true)

		// Live D1 row after completed cursors: compare mismatches, reopens backfill
		// while retaining cursors so the next tick repairs only the new row.
		await seedMessageGraph({
			userId,
			messageId: 'parity-msg-3',
			threadId: 'parity-thread-3',
			createdAt: '2026-07-01T12:03:00.000Z',
		})
		await env.APP_DB.prepare(
			`UPDATE users SET mailbox_parity_checked_at = NULL WHERE stable_user_id = ?`,
		)
			.bind(userId)
			.run()
		await parkOther(otherUserId)

		const mismatchNow = new Date('2026-08-01T11:00:00.000Z')
		vi.setSystemTime(mismatchNow)
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
		const afterMismatch = await readParityState(userId)
		expect(afterMismatch).toMatchObject({
			matchingSince: null,
			mismatchCount: 1,
			contentWatermarkAt: expect.any(String),
			messagesCompletedAt: null,
			orphanEventsCompletedAt: null,
			messageCursorId: 'parity-msg-2',
			orphanCursorId: 'parity-orphan-1',
			checkedAt: mismatchNow.toISOString(),
		})
		expect(afterMismatch?.contentWatermarkAt).not.toBeNull()

		await env.APP_DB.prepare(
			`UPDATE users SET mailbox_parity_checked_at = NULL WHERE stable_user_id = ?`,
		)
			.bind(userId)
			.run()
		await parkOther(otherUserId)
		const rematchNow = new Date('2026-08-01T12:00:00.000Z')
		vi.setSystemTime(rematchNow)
		await expect(
			reconcileMailboxParity({ env, now: rematchNow, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 1,
			compared: 1,
			matched: 1,
			mismatched: 0,
			failed: 0,
		})
		expect(
			await mailbox.getMessage({ messageId: 'parity-msg-3' }),
		).toMatchObject({ id: 'parity-msg-3' })
		expect(await mailbox.countMailbox()).toEqual(
			await countD1MailboxParity({ db: env.APP_DB, userId }),
		)
		const afterRematch = await readParityState(userId)
		expect(afterRematch).toMatchObject({
			matchingSince: rematchNow.toISOString(),
			mismatchCount: 0,
			contentWatermarkAt: expect.any(String),
			messagesCompletedAt: expect.any(String),
			orphanEventsCompletedAt: expect.any(String),
			messageCursorId: 'parity-msg-3',
		})

		await env.APP_DB.prepare(
			`UPDATE users SET mailbox_parity_checked_at = NULL WHERE stable_user_id = ?`,
		)
			.bind(userId)
			.run()
		await parkOther(otherUserId)
		const soakNow = new Date('2026-08-02T12:00:00.000Z')
		vi.setSystemTime(soakNow)
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
		const afterSoak = await readParityState(userId)
		expect(afterSoak?.matchingSince).toBe(rematchNow.toISOString())
		expect(afterSoak?.contentWatermarkAt).toEqual(expect.any(String))
		expect(afterSoak?.checkedAt).toBe(soakNow.toISOString())
		expect(afterSoak?.mismatchCount).toBe(0)
	} finally {
		vi.useRealTimers()
	}
}, 30_000)
