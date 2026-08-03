import { expect, test } from 'vitest'
import {
	baseAttachment,
	baseMessage,
	rpcFor,
	uniqueUserId,
} from './mailbox-test-helpers.ts'

test('Mailbox attachment reads are isolated by owner object identity', async () => {
	const ownerId = uniqueUserId('attachment-owner')
	const message = baseMessage(ownerId)
	const attachment = baseAttachment(ownerId, message.id)
	await rpcFor(ownerId).upsertMessageGraph({
		ownerId,
		message,
		attachments: [attachment],
	})

	await expect(
		rpcFor(ownerId).listAttachmentsForMessage({ messageId: message.id }),
	).resolves.toEqual([
		expect.objectContaining({
			id: attachment.id,
			messageId: message.id,
			filename: 'note.txt',
		}),
	])
	await expect(
		rpcFor(ownerId).listAttachmentsForMessage({
			messageId: `other-${crypto.randomUUID()}`,
		}),
	).resolves.toEqual([])
}, 30_000)
