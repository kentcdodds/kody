import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getEmailAttachmentById: vi.fn(),
}))

vi.mock('#worker/email/repo.ts', () => ({
	getEmailAttachmentById: (...args: Array<unknown>) =>
		mockModule.getEmailAttachmentById(...args),
}))

const { emailAttachmentGetCapability } =
	await import('./email-attachment-get.ts')
const { createMcpCallerContext } = await import('#mcp/context.ts')

test('emailAttachmentGetCapability returns attachment content from repo helper', async () => {
	mockModule.getEmailAttachmentById.mockResolvedValueOnce({
		id: 'attachment-1',
		messageId: 'message-1',
		filename: 'note.txt',
		contentType: 'text/plain',
		contentId: null,
		disposition: 'attachment',
		size: 12,
		storageKind: 'raw-mime',
		storageKey: null,
		createdAt: '2026-04-30T00:00:00.000Z',
		contentBase64: 'QXR0YWNobWVudCB0ZXh0',
	})

	const result = await emailAttachmentGetCapability.handler(
		{ attachment_id: 'attachment-1' },
		{
			env: { APP_DB: {} } as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://example.com',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'User Example',
				},
			}),
		},
	)

	expect(mockModule.getEmailAttachmentById).toHaveBeenCalledWith({
		db: {},
		userId: 'user-1',
		attachmentId: 'attachment-1',
	})
	expect(result).toEqual({
		id: 'attachment-1',
		message_id: 'message-1',
		filename: 'note.txt',
		content_type: 'text/plain',
		content_id: null,
		disposition: 'attachment',
		size: 12,
		data_base64: 'QXR0YWNobWVudCB0ZXh0',
	})
})

test('emailAttachmentGetCapability throws when attachment is missing', async () => {
	mockModule.getEmailAttachmentById.mockResolvedValueOnce(null)

	await expect(
		emailAttachmentGetCapability.handler(
			{ attachment_id: 'missing-attachment' },
			{
				env: { APP_DB: {} } as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: 'user-1',
						email: 'user@example.com',
						displayName: 'User Example',
					},
				}),
			},
		),
	).rejects.toThrow('Email attachment not found: missing-attachment')
})
