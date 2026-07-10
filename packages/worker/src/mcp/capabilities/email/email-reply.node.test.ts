import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	getEmailMessageById: vi.fn(),
	sendOutboundEmail: vi.fn(),
}))

vi.mock('#worker/email/repo.ts', () => ({
	getEmailMessageById: mocks.getEmailMessageById,
}))

vi.mock('#worker/email/outbound.ts', () => ({
	maxOutboundEmailAttachments: 10,
	sendOutboundEmail: mocks.sendOutboundEmail,
}))

const { emailReplyCapability } = await import('./email-reply.ts')

function createUsersDb(emailVerifiedAt: string | null) {
	return {
		prepare: () => ({
			bind: () => ({
				first: async () => ({ email_verified_at: emailVerifiedAt }),
			}),
		}),
	} as unknown as D1Database
}

function createContext(options: { emailVerifiedAt?: string | null } = {}) {
	return {
		env: {
			APP_DB: createUsersDb(
				options.emailVerifiedAt === undefined
					? '2026-01-01T00:00:00.000Z'
					: options.emailVerifiedAt,
			),
		} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User Example',
			},
		}),
	}
}

const inboundMessage = {
	id: 'inbound-1',
	subject: 'Hello',
	fromAddress: 'sender@example.com',
	envelopeFrom: null,
	replyToAddresses: [],
	messageIdHeader: '<inbound@example.com>',
	references: [],
	threadId: 'thread-1',
	inboxId: 'inbox-1',
}

test('email_reply gates unverified accounts, surfaces failed delivery, and forwards attachments', async () => {
	await expect(
		emailReplyCapability.handler(
			{
				message_id: 'inbound-1',
				from: 'kody@heykody.dev',
				text: 'Reply body',
			},
			createContext({ emailVerifiedAt: null }),
		),
	).rejects.toThrow(/Account email is not verified/)
	expect(mocks.sendOutboundEmail).not.toHaveBeenCalled()

	mocks.getEmailMessageById.mockResolvedValue(inboundMessage)
	mocks.sendOutboundEmail.mockResolvedValue({
		status: 'failed',
		error: 'Invalid email address: Invalid input',
		providerMessageId: null,
		message: {
			id: 'outbound-1',
			direction: 'outbound',
			inboxId: 'inbox-1',
			threadId: 'thread-1',
			fromAddress: 'user@heykody.dev',
			envelopeFrom: 'user@heykody.dev',
			toAddresses: ['sender@example.com'],
			subject: 'Re: Hello',
			messageIdHeader: '<outbound@heykody.dev>',
			processingStatus: 'failed',
			providerMessageId: null,
			error: 'Invalid email address: Invalid input',
			receivedAt: null,
			sentAt: null,
			createdAt: '2026-05-13T07:30:16.000Z',
			updatedAt: '2026-05-13T07:30:16.000Z',
		},
	})

	await expect(
		emailReplyCapability.handler(
			{
				message_id: 'inbound-1',
				text: 'Reply body',
			},
			createContext(),
		),
	).rejects.toThrow(
		'Email reply delivery failed: Invalid email address: Invalid input',
	)
	expect(mocks.sendOutboundEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			accountEmail: 'user@example.com',
			recipientPolicy: 'reply',
			replyToMessageId: 'inbound-1',
			subject: 'Re: Hello',
			inReplyToHeader: '<inbound@example.com>',
			threadId: 'thread-1',
			inboxId: 'inbox-1',
		}),
	)

	mocks.sendOutboundEmail.mockResolvedValue({
		status: 'sent',
		error: null,
		providerMessageId: 'provider-1',
		message: {
			id: 'outbound-2',
			direction: 'outbound',
			inboxId: 'inbox-1',
			threadId: 'thread-1',
			fromAddress: 'user@heykody.dev',
			envelopeFrom: 'user@heykody.dev',
			toAddresses: ['sender@example.com'],
			subject: 'Re: Hello',
			messageIdHeader: '<outbound@heykody.dev>',
			processingStatus: 'sent',
			providerMessageId: 'provider-1',
			error: null,
			receivedAt: null,
			sentAt: '2026-05-13T07:30:16.000Z',
			createdAt: '2026-05-13T07:30:16.000Z',
			updatedAt: '2026-05-13T07:30:16.000Z',
		},
	})

	await emailReplyCapability.handler(
		{
			message_id: 'inbound-1',
			text: 'Reply body',
			attachments: [
				{
					filename: 'notes.txt',
					content_type: 'text/plain',
					content_base64: 'aGVsbG8=',
				},
			],
		},
		createContext(),
	)
	expect(mocks.sendOutboundEmail).toHaveBeenLastCalledWith(
		expect.objectContaining({
			recipientPolicy: 'reply',
			replyToMessageId: 'inbound-1',
			attachments: [
				{
					filename: 'notes.txt',
					contentType: 'text/plain',
					contentBase64: 'aGVsbG8=',
				},
			],
		}),
	)
})
