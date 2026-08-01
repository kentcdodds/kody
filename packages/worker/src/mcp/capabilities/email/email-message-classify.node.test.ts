import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	setEmailMessageClassification: vi.fn(),
	mirrorMailboxMessageGraphFromD1: vi.fn(async () => ({
		messageId: 'message-1',
		message: { status: 'mirrored' },
		events: [],
	})),
}))

vi.mock('#worker/email/repo.ts', () => ({
	setEmailMessageClassification: mocks.setEmailMessageClassification,
}))

vi.mock('#worker/email/mailbox-live-mirror.ts', () => ({
	mirrorMailboxMessageGraphFromD1: mocks.mirrorMailboxMessageGraphFromD1,
}))

const { emailMessageClassifyCapability } =
	await import('./email-message-classify.ts')

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

test('email_message_classify updates classification and reports not-found', async () => {
	const context = createContext()
	mocks.setEmailMessageClassification.mockResolvedValueOnce(true)

	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'message-1', classification: 'quarantined' },
			context,
		),
	).resolves.toEqual({
		message_id: 'message-1',
		classification: 'quarantined',
	})
	expect(mocks.setEmailMessageClassification).toHaveBeenCalledWith({
		db: context.env.APP_DB,
		userId: 'user-1',
		messageId: 'message-1',
		classification: 'quarantined',
		classificationReason: 'Reclassified by user.',
	})
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledWith({
		env: context.env,
		db: context.env.APP_DB,
		userId: 'user-1',
		messageId: 'message-1',
	})

	mocks.setEmailMessageClassification.mockResolvedValueOnce(true)
	mocks.mirrorMailboxMessageGraphFromD1.mockClear()
	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'message-1', classification: 'accepted' },
			context,
		),
	).resolves.toEqual({
		message_id: 'message-1',
		classification: 'accepted',
	})
	expect(mocks.setEmailMessageClassification).toHaveBeenLastCalledWith({
		db: context.env.APP_DB,
		userId: 'user-1',
		messageId: 'message-1',
		classification: 'accepted',
		classificationReason: null,
	})
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledWith({
		env: context.env,
		db: context.env.APP_DB,
		userId: 'user-1',
		messageId: 'message-1',
	})

	mocks.setEmailMessageClassification.mockResolvedValueOnce(false)
	mocks.mirrorMailboxMessageGraphFromD1.mockClear()
	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'missing', classification: 'quarantined' },
			context,
		),
	).rejects.toThrow('Email message not found: missing')
	expect(mocks.mirrorMailboxMessageGraphFromD1).not.toHaveBeenCalled()

	mocks.setEmailMessageClassification.mockResolvedValueOnce(true)
	mocks.mirrorMailboxMessageGraphFromD1.mockResolvedValueOnce({
		messageId: 'message-1',
		message: {
			status: 'error',
			error: new Error('mailbox mirror timed out'),
		},
		events: [],
	})
	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'message-1', classification: 'quarantined' },
			context,
		),
	).resolves.toEqual({
		message_id: 'message-1',
		classification: 'quarantined',
	})
})
