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
	sendOutboundEmail: mocks.sendOutboundEmail,
}))

const { emailReplyCapability } = await import('./email-reply.ts')

function createContext() {
	return {
		env: {} as Env,
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

test('email_reply throws when provider delivery is persisted as failed', async () => {
	mocks.getEmailMessageById.mockResolvedValue({
		id: 'inbound-1',
		subject: 'Hello',
		fromAddress: 'sender@example.com',
		envelopeFrom: null,
		replyToAddresses: [],
		messageIdHeader: '<inbound@example.com>',
		references: [],
		threadId: 'thread-1',
		inboxId: 'inbox-1',
	})
	mocks.sendOutboundEmail.mockResolvedValue({
		status: 'failed',
		error: 'Invalid email address: Invalid input',
		providerMessageId: null,
		message: {
			id: 'outbound-1',
			direction: 'outbound',
			inboxId: 'inbox-1',
			threadId: 'thread-1',
			fromAddress: 'kody@heykody.dev',
			envelopeFrom: 'kody@heykody.dev',
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
				from: 'kody@heykody.dev',
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
			from: 'kody@heykody.dev',
			to: 'sender@example.com',
			subject: 'Re: Hello',
			inReplyToHeader: '<inbound@example.com>',
			threadId: 'thread-1',
			inboxId: 'inbox-1',
		}),
	)
})
