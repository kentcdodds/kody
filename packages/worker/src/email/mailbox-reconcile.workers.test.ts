import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { mailboxLiveMirrorMaxEvents } from './mailbox-live-mirror.ts'
import {
	countD1MailboxParity,
	listUsersForMailboxParity,
	reconcileMailboxParity,
} from './mailbox-reconcile.ts'
import {
	baseDeliveryEvent,
	baseMessage,
	rpcFor,
} from './mailbox-test-helpers.ts'
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
	eventCount?: number
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
	const eventCount = input.eventCount ?? 1
	const baseMs = Date.parse(input.createdAt)
	for (let index = 0; index < eventCount; index += 1) {
		await env.APP_DB.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, event_type, provider, detail_json, created_at
			) VALUES (?, ?, ?, 'sent', 'kody', '{}', ?)`,
		)
			.bind(
				`evt-${input.messageId}-${String(index).padStart(3, '0')}`,
				input.messageId,
				input.userId,
				new Date(baseMs + index * 1000).toISOString(),
			)
			.run()
	}
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
			mailbox_parity_content_replay_upper_at AS contentReplayUpperAt,
			mailbox_parity_message_backfill_cursor_id AS messageCursorId,
			mailbox_parity_message_backfill_completed_at AS messagesCompletedAt,
			mailbox_parity_event_backfill_cursor_id AS eventCursorId,
			mailbox_parity_event_backfill_completed_at AS eventsCompletedAt,
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
			contentReplayUpperAt: string | null
			messageCursorId: string | null
			messagesCompletedAt: string | null
			eventCursorId: string | null
			eventsCompletedAt: string | null
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

test('reconcileMailboxParity mismatch full reset and soak', async () => {
	silenceIncidentalRuntimeWarnings()
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
		await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

		const firstNow = new Date('2026-08-01T10:00:00.000Z')
		vi.setSystemTime(firstNow)
		// 2 messages + 2 bound events + 1 orphan
		await expect(
			reconcileMailboxParity({ env, now: firstNow, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 5,
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
			contentReplayUpperAt: null,
			mismatchCount: 0,
			messagesCompletedAt: expect.any(String),
			eventsCompletedAt: expect.any(String),
			messageCursorId: 'parity-msg-2',
			eventCursorId: 'parity-orphan-1',
			lastError: null,
		})

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
			messagesCompletedAt: null,
			eventsCompletedAt: null,
			messageCursorId: null,
			eventCursorId: null,
			contentWatermarkAt: null,
			contentReplayUpperAt: null,
			checkedAt: mismatchNow.toISOString(),
		})

		await env.APP_DB.prepare(
			`UPDATE users SET mailbox_parity_checked_at = NULL WHERE stable_user_id = ?`,
		)
			.bind(userId)
			.run()
		await parkOther(otherUserId)
		const rematchNow = new Date('2026-08-01T12:00:00.000Z')
		vi.setSystemTime(rematchNow)
		// Full historical rescan: 3 messages + 3 bound events + 1 orphan
		await expect(
			reconcileMailboxParity({ env, now: rematchNow, batchSize: 1 }),
		).resolves.toEqual({
			scanned: 1,
			backfilled: 7,
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
			messagesCompletedAt: expect.any(String),
			eventsCompletedAt: expect.any(String),
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
		expect(afterSoak?.checkedAt).toBe(soakNow.toISOString())
		expect(afterSoak?.mismatchCount).toBe(0)
	} finally {
		vi.useRealTimers()
	}
}, 30_000)

test('reconcileMailboxParity purges DO-only leftover for tracked empty owners', async () => {
	silenceIncidentalRuntimeWarnings(['mailbox-live-mirror-events-truncated'])
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureEmailTestSchema(env.APP_DB)

	await env.APP_DB.prepare(
		`UPDATE users
		SET mailbox_parity_checked_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const userId = await seedParityUser({
		email: `do-extra-${crypto.randomUUID()}@example.test`,
		checkedAt: null,
	})
	await seedMessageGraph({
		userId,
		messageId: 'do-extra-msg',
		threadId: 'do-extra-thread',
		createdAt: '2026-07-01T12:00:00.000Z',
	})
	const mailbox = rpcFor(userId)
	await mailbox.getMessage({ messageId: 'warmup-nonexistent' })

	const firstNow = new Date('2026-08-01T10:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: firstNow, batchSize: 1 }),
	).resolves.toMatchObject({ matched: 1 })
	expect(await mailbox.countMailbox()).toEqual(
		await countD1MailboxParity({ db: env.APP_DB, userId }),
	)

	// Failed delete mirror: clear D1, leave Mailbox metadata populated.
	await env.APP_DB.prepare(
		`DELETE FROM email_delivery_events WHERE user_id = ?`,
	)
		.bind(userId)
		.run()
	await env.APP_DB.prepare(`DELETE FROM email_attachments WHERE message_id = ?`)
		.bind('do-extra-msg')
		.run()
	await env.APP_DB.prepare(`DELETE FROM email_messages WHERE user_id = ?`)
		.bind(userId)
		.run()
	await env.APP_DB.prepare(`DELETE FROM email_threads WHERE user_id = ?`)
		.bind(userId)
		.run()
	await mailbox.mirrorMessage({
		ownerId: userId,
		message: baseMessage(userId, { id: 'do-extra-msg' }),
	})
	await mailbox.upsertDeliveryEvents({
		ownerId: userId,
		events: [
			baseDeliveryEvent({
				id: 'do-extra-evt',
				messageId: 'do-extra-msg',
			}),
		],
	})
	expect((await mailbox.countMailbox()).messages).toBeGreaterThan(0)
	expect(
		(await listUsersForMailboxParity({ db: env.APP_DB, limit: 10 })).some(
			(row) => row.userId === userId,
		),
	).toBe(true)

	await env.APP_DB.prepare(
		`UPDATE users SET mailbox_parity_checked_at = NULL WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.run()
	const mismatchNow = new Date('2026-08-01T11:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: mismatchNow, batchSize: 1 }),
	).resolves.toMatchObject({
		compared: 1,
		matched: 0,
		mismatched: 1,
		failed: 0,
	})
	expect(await readParityState(userId)).toMatchObject({
		matchingSince: null,
		mismatchCount: 1,
		contentWatermarkAt: null,
		messagesCompletedAt: null,
		eventsCompletedAt: null,
	})
	expect(await mailbox.countMailbox()).toEqual({
		threads: 0,
		messages: 0,
		attachments: 0,
		deliveryEvents: 0,
	})

	await env.APP_DB.prepare(
		`UPDATE users SET mailbox_parity_checked_at = NULL WHERE stable_user_id = ?`,
	)
		.bind(userId)
		.run()
	const zeroNow = new Date('2026-08-01T12:00:00.000Z')
	await expect(
		reconcileMailboxParity({ env, now: zeroNow, batchSize: 1 }),
	).resolves.toMatchObject({ matched: 1, mismatched: 0 })
	expect(await readParityState(userId)).toMatchObject({
		matchingSince: zeroNow.toISOString(),
		mismatchCount: 0,
	})
	expect(await mailbox.countMailbox()).toEqual(
		await countD1MailboxParity({ db: env.APP_DB, userId }),
	)
}, 30_000)

test('reconcileMailboxParity eventually repairs >100 bound delivery events', async () => {
	silenceIncidentalRuntimeWarnings([
		'mailbox-parity-reconcile-user-failed',
		'mailbox-parity-message-backfill-retryable',
		'mailbox-parity-event-backfill-retryable',
		'mailbox-parity-content-replay-retryable',
		'mailbox-live-mirror-events-truncated',
	])
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureEmailTestSchema(env.APP_DB)

	await env.APP_DB.prepare(
		`UPDATE users
		SET mailbox_parity_checked_at = '9999-12-31T23:59:59.999Z'`,
	).run()

	const heavyUserId = await seedParityUser({
		email: `heavy-${crypto.randomUUID()}@example.test`,
		checkedAt: null,
	})
	const heavyEventCount = mailboxLiveMirrorMaxEvents + 5
	await seedMessageGraph({
		userId: heavyUserId,
		messageId: 'heavy-msg-1',
		threadId: 'heavy-thread-1',
		createdAt: '2026-07-02T12:00:00.000Z',
		eventCount: heavyEventCount,
	})
	const heavyMailbox = rpcFor(heavyUserId)
	await heavyMailbox.getMessage({ messageId: 'warmup-nonexistent' })

	let matched = 0
	let backfilled = 0
	for (let tick = 0; tick < 30; tick += 1) {
		await env.APP_DB.prepare(
			`UPDATE users SET mailbox_parity_checked_at = NULL WHERE stable_user_id = ?`,
		)
			.bind(heavyUserId)
			.run()
		const metrics = await reconcileMailboxParity({
			env,
			now: new Date(Date.UTC(2026, 7, 3, 10, tick)),
			batchSize: 1,
		})
		backfilled += metrics.backfilled
		matched += metrics.matched
		if (metrics.matched > 0) break
	}
	expect(matched).toBeGreaterThan(0)
	expect(backfilled).toBeGreaterThan(mailboxLiveMirrorMaxEvents)
	expect(await heavyMailbox.countMailbox()).toEqual(
		await countD1MailboxParity({ db: env.APP_DB, userId: heavyUserId }),
	)
	expect(
		(await countD1MailboxParity({ db: env.APP_DB, userId: heavyUserId }))
			.deliveryEvents,
	).toBe(heavyEventCount)
}, 60_000)
