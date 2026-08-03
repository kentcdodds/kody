import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	listDueInboundOwners,
	replaceInboundDueOwnerHint,
} from './inbound-due-owners.ts'
import { type Mailbox } from './mailbox-do.ts'
import { rpcFor, stubFor, uniqueUserId } from './mailbox-test-helpers.ts'
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
