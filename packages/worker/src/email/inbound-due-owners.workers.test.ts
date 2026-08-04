import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import {
	hintInboundDueOwner,
	listDueInboundOwners,
	replaceInboundDueOwnerHint,
} from './inbound-due-owners.ts'
import { type Mailbox } from './mailbox-do.ts'
import { rpcFor, stubFor, uniqueUserId } from './mailbox-test-helpers.ts'
import { sweepStaleInboundDeliveries } from './reconcile-inbound-deliveries.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('Mailbox alarm repairs a missed due-owner transition hint', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = uniqueUserId('due-hint-repair')
	const mailbox = rpcFor(userId)
	await mailbox.upsertMessageGraph({
		ownerId: userId,
		message: {
			id: 'due-hint-owner-bind',
			direction: 'outbound',
			inboxId: null,
			threadId: null,
			senderIdentityId: null,
			fromAddress: 'owner@example.test',
			envelopeFrom: null,
			toAddresses: [],
			ccAddresses: [],
			bccAddresses: [],
			replyToAddresses: [],
			subject: '',
			messageIdHeader: null,
			inReplyToHeader: null,
			references: [],
			headers: {},
			authResults: null,
			textBody: null,
			htmlBody: null,
			rawMimeKey: null,
			rawSize: 0,
			processingStatus: 'stored',
			classification: 'accepted',
			classificationReason: null,
			providerMessageId: null,
			deliveryStatus: null,
			deliveryStatusAt: null,
			error: null,
			receivedAt: null,
			sentAt: null,
			createdAt: '2026-08-03T00:00:00.000Z',
			updatedAt: '2026-08-03T00:00:00.000Z',
		},
	})
	await runInDurableObject(
		stubFor(userId),
		async (instance: Mailbox, state) => {
			state.storage.sql.exec(
				`INSERT INTO email_delivery_events (
				id, event_type, provider, needs_effect_reconcile, state,
				created_at, updated_at
			) VALUES (?, 'received', 'cloudflare-email-routing', 1, 'received', ?, ?)`,
				'due-hint-event',
				'2026-08-03T00:00:00.000Z',
				'2026-08-03T00:00:00.000Z',
			)
			await instance.alarm()
		},
	)
	expect(
		await env.APP_DB.prepare(
			`SELECT user_id, reason
			FROM email_inbound_due_owners
			WHERE user_id = ?`,
		)
			.bind(userId)
			.first(),
	).toEqual({ user_id: userId, reason: 'mailbox-due-work' })
})

test('due-owner discovery is bounded and ordered without a users scan', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-08-03T12:00:00.000Z')
	for (const [index, dueAt] of [
		'2026-08-03T11:03:00.000Z',
		'2026-08-03T11:01:00.000Z',
		'2026-08-03T11:02:00.000Z',
		'2026-08-03T11:00:00.000Z',
	].entries()) {
		await replaceInboundDueOwnerHint({
			db: env.APP_DB,
			userId: `due-owner-${index}`,
			dueAt,
			reason: 'test',
			now,
		})
	}
	const due = await listDueInboundOwners({ db: env.APP_DB, now, limit: 3 })
	expect(due.map((owner) => owner.dueAt)).toEqual([
		'2026-08-03T11:00:00.000Z',
		'2026-08-03T11:01:00.000Z',
		'2026-08-03T11:02:00.000Z',
	])
})

test('due-owner drain is bounded and ordered by due time', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-08-03T12:00:00.000Z')
	const backlogDueAt = '2026-08-03T11:00:00.000Z'
	const latestDueAt = '2026-08-03T11:59:00.000Z'
	const latestUserId = `latest-${crypto.randomUUID()}`
	await env.APP_DB.batch([
		...Array.from({ length: 100 }, (_, index) =>
			env.APP_DB.prepare(
				`INSERT INTO email_inbound_due_owners (
						user_id, due_at, reason, attempt_count, last_error, updated_at
					) VALUES (?, ?, 'scheduled-refresh', 0, NULL, ?)`,
			).bind(
				`backlog-${String(index).padStart(3, '0')}-${crypto.randomUUID()}`,
				backlogDueAt,
				now.toISOString(),
			),
		),
		env.APP_DB.prepare(
			`INSERT INTO email_inbound_due_owners (
					user_id, due_at, reason, attempt_count, last_error, updated_at
				) VALUES (?, ?, 'mailbox-due-work', 0, NULL, ?)`,
		).bind(latestUserId, latestDueAt, now.toISOString()),
	])

	const batchSizes: Array<number> = []
	const drainedUserIds: Array<string> = []
	for (;;) {
		const due = await listDueInboundOwners({ db: env.APP_DB, now })
		if (due.length === 0) break
		batchSizes.push(due.length)
		drainedUserIds.push(...due.map((owner) => owner.userId))
		await env.APP_DB.batch(
			due.map((owner) =>
				env.APP_DB.prepare(
					`DELETE FROM email_inbound_due_owners WHERE user_id = ?`,
				).bind(owner.userId),
			),
		)
	}

	expect(drainedUserIds.at(-1)).toBe(latestUserId)
	expect(batchSizes).toEqual([25, 25, 25, 25, 1])
	expect(drainedUserIds).toHaveLength(101)
})

test('hint upsert keeps the earliest due time and its reason', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-08-03T12:00:00.000Z')
	const userId = `hint-merge-${crypto.randomUUID()}`
	await hintInboundDueOwner({
		db: env.APP_DB,
		userId,
		dueAt: '2026-08-03T11:30:00.000Z',
		reason: 'mailbox-due-work',
		now,
	})
	// A later hint never moves the due time forward or replaces the reason.
	await hintInboundDueOwner({
		db: env.APP_DB,
		userId,
		dueAt: '2026-08-03T11:45:00.000Z',
		reason: 'scheduled-refresh',
		now,
	})
	// An earlier hint wins both the due time and the reason.
	await hintInboundDueOwner({
		db: env.APP_DB,
		userId,
		dueAt: '2026-08-03T11:15:00.000Z',
		reason: 'scheduled-refresh',
		now,
	})
	expect(
		await env.APP_DB.prepare(
			`SELECT due_at, reason FROM email_inbound_due_owners WHERE user_id = ?`,
		)
			.bind(userId)
			.first(),
	).toEqual({
		due_at: '2026-08-03T11:15:00.000Z',
		reason: 'scheduled-refresh',
	})
})

test('sweep time budget defers later owners to the next pass', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-08-03T12:00:00.000Z')
	const earlierEmail = `budget-earlier-${crypto.randomUUID()}@example.test`
	const laterEmail = `budget-later-${crypto.randomUUID()}@example.test`
	const earlierUserId = await createStableUserIdFromEmail(earlierEmail)
	const laterUserId = await createStableUserIdFromEmail(laterEmail)
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id
			) VALUES (?, ?, 'hash', ?)`,
		).bind(`earlier-${crypto.randomUUID()}`, earlierEmail, earlierUserId),
		env.APP_DB.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id
			) VALUES (?, ?, 'hash', ?)`,
		).bind(`later-${crypto.randomUUID()}`, laterEmail, laterUserId),
	])
	await replaceInboundDueOwnerHint({
		db: env.APP_DB,
		userId: earlierUserId,
		dueAt: '2026-08-03T10:00:00.000Z',
		reason: 'scheduled-refresh',
		now,
	})
	await replaceInboundDueOwnerHint({
		db: env.APP_DB,
		userId: laterUserId,
		dueAt: '2026-08-03T11:00:00.000Z',
		reason: 'mailbox-due-work',
		now,
	})
	await Promise.all([
		rpcFor(earlierUserId).getInboundDueWorkHint({ ownerId: earlierUserId }),
		rpcFor(laterUserId).getInboundDueWorkHint({ ownerId: laterUserId }),
	])
	const clockValues = [0, 0, 10_001, 10_001]

	await expect(
		sweepStaleInboundDeliveries({
			env: { ...env, APP_BASE_URL: 'https://kody.example.com' },
			now,
			clock: () => clockValues.shift() ?? 10_001,
		}),
	).resolves.toMatchObject({
		usersProcessed: 1,
		errors: 0,
		budgetExhausted: true,
	})
	const rows = await env.APP_DB.prepare(
		`SELECT user_id, reason
		FROM email_inbound_due_owners
		WHERE user_id IN (?, ?)
		ORDER BY user_id`,
	)
		.bind(earlierUserId, laterUserId)
		.all<{ user_id: string; reason: string }>()
	expect(rows.results).toEqual([
		{ user_id: laterUserId, reason: 'mailbox-due-work' },
	])
})

test('sweep clears a healthy Mailbox hint and retains pending due work', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const now = new Date('2026-08-03T12:00:00.000Z')
	const dueAt = now.toISOString()
	const healthyEmail = `healthy-${crypto.randomUUID()}@example.test`
	const pendingEmail = `pending-${crypto.randomUUID()}@example.test`
	const healthyUserId = await createStableUserIdFromEmail(healthyEmail)
	const pendingUserId = await createStableUserIdFromEmail(pendingEmail)
	await env.APP_DB.batch([
		env.APP_DB.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id
			) VALUES (?, ?, 'hash', ?)`,
		).bind(`healthy-${crypto.randomUUID()}`, healthyEmail, healthyUserId),
		env.APP_DB.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id
			) VALUES (?, ?, 'hash', ?)`,
		).bind(`pending-${crypto.randomUUID()}`, pendingEmail, pendingUserId),
	])
	for (const userId of [healthyUserId, pendingUserId]) {
		await replaceInboundDueOwnerHint({
			db: env.APP_DB,
			userId,
			dueAt,
			reason: 'scheduled-refresh',
			now,
		})
		await rpcFor(userId).getInboundDueWorkHint({ ownerId: userId })
	}

	await runInDurableObject(
		stubFor(pendingUserId),
		async (instance: Mailbox, state) => {
			await instance.getInboundDueWorkHint({ ownerId: pendingUserId })
			state.storage.sql.exec(
				`INSERT INTO email_delivery_events (
					id, event_type, provider, needs_effect_reconcile, state,
					created_at, updated_at
				) VALUES (?, 'receive_started', 'cloudflare-email-routing', 0,
					'pending', ?, ?)`,
				`pending-${crypto.randomUUID()}`,
				dueAt,
				dueAt,
			)
		},
	)

	await expect(
		sweepStaleInboundDeliveries({
			env: { ...env, APP_BASE_URL: 'https://kody.example.com' },
			now,
		}),
	).resolves.toMatchObject({ usersProcessed: 2, errors: 0 })
	const rows = await env.APP_DB.prepare(
		`SELECT user_id, due_at, reason
		FROM email_inbound_due_owners
		WHERE user_id IN (?, ?)
		ORDER BY user_id`,
	)
		.bind(healthyUserId, pendingUserId)
		.all<{ user_id: string; due_at: string; reason: string }>()
	expect(rows.results).toEqual([
		{
			user_id: pendingUserId,
			due_at: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
			reason: 'scheduled-refresh',
		},
	])
})
