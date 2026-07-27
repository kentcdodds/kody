import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	setEmailMessageClassification: vi.fn(),
}))

vi.mock('#worker/email/repo.ts', () => ({
	setEmailMessageClassification: mocks.setEmailMessageClassification,
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

test('email_message_classify quarantines with a user reason and accepts with null reason', async () => {
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

	mocks.setEmailMessageClassification.mockResolvedValueOnce(true)
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
})

test('email_message_classify reports not-found for missing or non-inbound messages', async () => {
	const context = createContext()
	mocks.setEmailMessageClassification.mockResolvedValueOnce(false)

	await expect(
		emailMessageClassifyCapability.handler(
			{ message_id: 'missing', classification: 'quarantined' },
			context,
		),
	).rejects.toThrow('Email message not found: missing')
})
