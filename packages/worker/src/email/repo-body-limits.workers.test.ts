import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	maxRestorableTextColumnBytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'
import {
	createEmailThread,
	emailBodyTruncationNotice,
	getEmailThreadById,
	insertEmailDeliveryEvent,
	insertEmailMessage,
} from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

test('stored email bodies are bounded so D1 backups stay importable', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const oversized = `<p>${'x'.repeat(maxRestorableTextColumnBytes + 10_000)}</p>`

	const stored = await insertEmailMessage({
		db: env.APP_DB,
		message: {
			direction: 'inbound',
			userId: `user-${crypto.randomUUID()}`,
			fromAddress: 'sender@example.com',
			toAddresses: ['inbox@example.com'],
			subject: 'Giant newsletter',
			textBody: 'short text body',
			htmlBody: oversized,
			rawMimeKey: 'emails/user/raw.mime',
			processingStatus: 'stored',
		},
	})

	expect(stored.textBody).toBe('short text body')
	expect(stored.htmlBody?.endsWith(emailBodyTruncationNotice)).toBe(true)
	expect(utf8ByteLength(stored.htmlBody ?? '')).toBeLessThanOrEqual(
		maxRestorableTextColumnBytes,
	)
})

test('getEmailThreadById is owner-scoped and insertEmailDeliveryEvent returns the row', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const ownerId = `owner-${crypto.randomUUID()}`
	const otherUserId = `other-${crypto.randomUUID()}`
	const thread = await createEmailThread({
		db: env.APP_DB,
		userId: ownerId,
		subjectNormalized: 'hello thread',
		rootMessageIdHeader: '<root@example.com>',
	})

	expect(
		await getEmailThreadById({
			db: env.APP_DB,
			userId: ownerId,
			threadId: thread.id,
		}),
	).toMatchObject({
		id: thread.id,
		userId: ownerId,
		subjectNormalized: 'hello thread',
	})
	expect(
		await getEmailThreadById({
			db: env.APP_DB,
			userId: otherUserId,
			threadId: thread.id,
		}),
	).toBeNull()

	const createdAt = '2026-07-15T12:00:00.000Z'
	const inserted = await insertEmailDeliveryEvent({
		db: env.APP_DB,
		messageId: null,
		userId: ownerId,
		inboxId: null,
		eventType: 'send_requested',
		provider: 'cloudflare-email',
		detail: { subject: 'hello' },
		createdAt,
	})
	expect(inserted).toMatchObject({
		id: expect.any(String),
		userId: ownerId,
		eventType: 'send_requested',
		provider: 'cloudflare-email',
		detailJson: JSON.stringify({ subject: 'hello' }),
		createdAt,
	})
	const row = await env.APP_DB.prepare(
		`SELECT id, created_at FROM email_delivery_events WHERE id = ?`,
	)
		.bind(inserted.id)
		.first<{ id: string; created_at: string }>()
	expect(row).toEqual({ id: inserted.id, created_at: createdAt })
})
