import { expect, test, vi } from 'vitest'
import {
	countInternalEmailMessages,
	countInternalUserEmailMessages,
	exportInternalUserMailbox,
	getInternalEmailMessageById,
	listInternalEmailAttachmentsForMessage,
	listInternalUserEmailBlobReferences,
} from './mailbox-internal-read.ts'
import { type MailboxMessageRecord } from './mailbox-types.ts'

const {
	countEmailMessagesForUserMock,
	getEmailMessageByIdMock,
	listEmailAttachmentsForUserMessageMock,
} = vi.hoisted(() => ({
	countEmailMessagesForUserMock: vi.fn(),
	getEmailMessageByIdMock: vi.fn(),
	listEmailAttachmentsForUserMessageMock: vi.fn(),
}))

vi.mock('./repo.ts', () => ({
	countEmailMessagesForUser: (...args: Array<unknown>) =>
		countEmailMessagesForUserMock(...args),
	getEmailMessageById: (...args: Array<unknown>) =>
		getEmailMessageByIdMock(...args),
	listEmailAttachmentsForUserMessage: (...args: Array<unknown>) =>
		listEmailAttachmentsForUserMessageMock(...args),
}))

function mailboxMessage(): MailboxMessageRecord {
	return {
		id: 'message-1',
		direction: 'inbound',
		inboxId: 'inbox-1',
		threadId: 'thread-1',
		senderIdentityId: null,
		fromAddress: 'sender@example.test',
		envelopeFrom: 'sender@example.test',
		toAddresses: ['owner@example.test'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: 'Mailbox',
		messageIdHeader: '<message-1@example.test>',
		inReplyToHeader: null,
		references: [],
		headers: {},
		authResults: null,
		textBody: 'body',
		htmlBody: null,
		rawMimeKey: 'email-raw:v1:user-a/message-1',
		rawSize: 4,
		processingStatus: 'stored',
		classification: 'accepted',
		classificationReason: null,
		providerMessageId: null,
		deliveryStatus: null,
		deliveryStatusAt: null,
		error: null,
		receivedAt: '2026-08-02T00:00:00.000Z',
		sentAt: null,
		createdAt: '2026-08-02T00:00:00.000Z',
		updatedAt: '2026-08-02T00:00:00.000Z',
	}
}

function createEnv() {
	const attachment = {
		id: 'attachment-1',
		messageId: 'message-1',
		filename: 'note.txt',
		contentType: 'text/plain',
		contentId: null,
		disposition: 'attachment',
		size: 4,
		storageKind: 'external' as const,
		storageKey: 'email-attachment:v1:user-a/message-1/attachment-1',
		createdAt: '2026-08-02T00:00:00.000Z',
	}
	const rpc = {
		getMessage: vi.fn(async () => mailboxMessage()),
		listAttachmentsForMessage: vi.fn(async () => [attachment]),
		countMessages: vi.fn(async () => ({ total: 3 })),
		countMailbox: vi.fn(async () => ({
			threads: 1,
			messages: 3,
			attachments: 1,
			deliveryEvents: 2,
		})),
		exportMailbox: vi.fn(async () => ({
			rows: [],
			nextStartAfter: null,
			truncated: false,
		})),
		listBlobReferences: vi.fn(async () => ({
			references: [
				{
					kind: 'raw_mime' as const,
					key: 'email-raw:v1:user-a/message-1',
					messageId: 'message-1',
					attachmentId: null,
				},
			],
			nextStartAfter: null,
			truncated: false,
		})),
	}
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const get = vi.fn(() => rpc)
	return {
		env: {
			APP_DB: {} as D1Database,
			MAILBOX: { idFromName, get } as unknown as DurableObjectNamespace,
		},
		idFromName,
		rpc,
	}
}

test('USER internal reads use owner Mailbox only and map shared records', async () => {
	const { env, idFromName, rpc } = createEnv()

	await expect(
		getInternalEmailMessageById({
			env,
			ownerId: 'user-a',
			messageId: 'message-1',
		}),
	).resolves.toMatchObject({
		id: 'message-1',
		userId: 'user-a',
		subject: 'Mailbox',
	})
	await expect(
		listInternalEmailAttachmentsForMessage({
			env,
			ownerId: 'user-a',
			messageId: 'message-1',
		}),
	).resolves.toEqual([
		expect.objectContaining({ id: 'attachment-1', messageId: 'message-1' }),
	])
	await expect(
		countInternalEmailMessages({ env, ownerId: 'user-a' }),
	).resolves.toBe(3)
	await expect(
		countInternalUserEmailMessages({
			env: { MAILBOX: env.MAILBOX },
			ownerId: 'user-a',
		}),
	).resolves.toBe(3)
	await expect(
		exportInternalUserMailbox({ env, ownerId: 'user-a' }),
	).resolves.toMatchObject({ rows: [], truncated: false })
	await expect(
		listInternalUserEmailBlobReferences({ env, ownerId: 'user-a' }),
	).resolves.toMatchObject({
		references: [
			expect.objectContaining({ key: 'email-raw:v1:user-a/message-1' }),
		],
	})

	expect(idFromName).toHaveBeenCalledWith('user-a')
	expect(rpc.getMessage).toHaveBeenCalledWith({ messageId: 'message-1' })
	expect(getEmailMessageByIdMock).not.toHaveBeenCalled()
	expect(listEmailAttachmentsForUserMessageMock).not.toHaveBeenCalled()
	expect(countEmailMessagesForUserMock).not.toHaveBeenCalled()
})

test('USER internal reads fail closed without Mailbox and never query D1', async () => {
	const env = { APP_DB: {} as D1Database }
	await expect(
		getInternalEmailMessageById({
			env,
			ownerId: 'user-a',
			messageId: 'message-1',
		}),
	).rejects.toThrow('MAILBOX Durable Object binding is not configured')
	await expect(
		countInternalEmailMessages({ env, ownerId: 'user-a' }),
	).rejects.toThrow('MAILBOX Durable Object binding is not configured')
	expect(getEmailMessageByIdMock).not.toHaveBeenCalled()
	expect(countEmailMessagesForUserMock).not.toHaveBeenCalled()
})

test('system:email stays on explicit D1 reads and cannot access Mailbox export', async () => {
	const { env, idFromName } = createEnv()
	const d1Message = {
		...mailboxMessage(),
		userId: 'system:email',
	}
	const attachment = {
		id: 'system-attachment',
		messageId: 'system-message',
	}
	getEmailMessageByIdMock.mockResolvedValue(d1Message)
	listEmailAttachmentsForUserMessageMock.mockResolvedValue([attachment])
	countEmailMessagesForUserMock.mockResolvedValue(7)

	await expect(
		getInternalEmailMessageById({
			env,
			ownerId: 'system:email',
			messageId: 'system-message',
		}),
	).resolves.toBe(d1Message)
	await expect(
		listInternalEmailAttachmentsForMessage({
			env,
			ownerId: 'system:email',
			messageId: 'system-message',
		}),
	).resolves.toEqual([attachment])
	await expect(
		countInternalEmailMessages({ env, ownerId: 'system:email' }),
	).resolves.toBe(7)
	await expect(
		exportInternalUserMailbox({ env, ownerId: 'system:email' }),
	).rejects.toThrow('system:email has no Mailbox')
	await expect(
		listInternalUserEmailBlobReferences({
			env,
			ownerId: 'system:email',
		}),
	).rejects.toThrow('system:email has no Mailbox')

	expect(idFromName).not.toHaveBeenCalled()
	expect(getEmailMessageByIdMock).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'system:email',
		messageId: 'system-message',
	})
})
