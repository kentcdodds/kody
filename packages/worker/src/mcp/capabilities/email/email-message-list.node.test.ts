import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	listOwnerEmailMessages: vi.fn(),
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	listOwnerEmailMessages: mocks.listOwnerEmailMessages,
}))

const { emailMessageListCapability } = await import('./email-message-list.ts')

function createContext() {
	return {
		env: {
			APP_DB: {
				prepare: () => ({
					bind: () => ({
						first: async () => ({
							email_verified_at: '2026-01-01T00:00:00.000Z',
						}),
					}),
				}),
			} as unknown as D1Database,
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

test('email_message_list forwards classification filter and returns classification fields', async () => {
	const context = createContext()
	mocks.listOwnerEmailMessages.mockResolvedValueOnce([
		{
			id: 'message-1',
			direction: 'inbound',
			inboxId: 'inbox-1',
			threadId: null,
			fromAddress: 'spam@example.com',
			envelopeFrom: 'spam@example.com',
			toAddresses: ['user@example.com'],
			subject: 'Quarantined',
			messageIdHeader: '<spam@example.com>',
			processingStatus: 'stored',
			classification: 'quarantined',
			classificationReason: 'Matched sender rule.',
			providerMessageId: null,
			deliveryStatus: null,
			deliveryStatusAt: null,
			error: null,
			receivedAt: '2026-07-01T00:00:00.000Z',
			sentAt: null,
			createdAt: '2026-07-01T00:00:00.000Z',
			updatedAt: '2026-07-01T00:00:00.000Z',
		},
	])

	const result = await emailMessageListCapability.handler(
		{ classification: 'quarantined', limit: 10 },
		context,
	)

	expect(mocks.listOwnerEmailMessages).toHaveBeenCalledWith({
		env: context.env,
		ownerId: 'user-1',
		inboxId: null,
		direction: null,
		processingStatus: null,
		deliveryStatus: null,
		classification: 'quarantined',
		limit: 10,
	})
	expect(result.messages).toEqual([
		expect.objectContaining({
			id: 'message-1',
			classification: 'quarantined',
			classification_reason: 'Matched sender rule.',
		}),
	])
})
