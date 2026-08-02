import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { listEmailAttachmentsForUserMessage } from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'

async function insertMessageWithAttachment(input: {
	userId: string
	messageId: string
	attachmentId: string
}) {
	const createdAt = '2026-07-01T12:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO email_messages (
			id, direction, user_id, from_address, subject, processing_status,
			created_at, updated_at
		) VALUES (?, 'inbound', ?, 'sender@example.com', 'Hello', 'stored', ?, ?)`,
	)
		.bind(input.messageId, input.userId, createdAt, createdAt)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO email_attachments (
			id, message_id, filename, content_type, size, storage_kind, created_at
		) VALUES (?, ?, 'note.txt', 'text/plain', 12, 'unavailable', ?)`,
	)
		.bind(input.attachmentId, input.messageId, createdAt)
		.run()
}

test('listEmailAttachmentsForUserMessage scopes attachments to message owner', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const ownerId = `owner-${crypto.randomUUID()}`
	const otherId = `other-${crypto.randomUUID()}`
	const messageId = `msg-${crypto.randomUUID()}`
	const attachmentId = `att-${crypto.randomUUID()}`
	await insertMessageWithAttachment({
		userId: ownerId,
		messageId,
		attachmentId,
	})

	const ownerAttachments = await listEmailAttachmentsForUserMessage({
		db: env.APP_DB,
		userId: ownerId,
		messageId,
	})
	expect(ownerAttachments).toEqual([
		expect.objectContaining({
			id: attachmentId,
			messageId,
			filename: 'note.txt',
		}),
	])

	const crossOwnerAttachments = await listEmailAttachmentsForUserMessage({
		db: env.APP_DB,
		userId: otherId,
		messageId,
	})
	expect(crossOwnerAttachments).toEqual([])
})
