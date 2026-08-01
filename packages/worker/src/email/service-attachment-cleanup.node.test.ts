import { expect, test, vi } from 'vitest'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import type * as EmailRepo from './repo.ts'

const mocks = vi.hoisted(() => ({
	insertEmailMessage: vi.fn(),
	insertEmailAttachments: vi.fn(),
	deleteEmailMessageById: vi.fn(async () => undefined),
	getEmailMessageById: vi.fn(),
	withAccountWriteLease: vi.fn(
		async (input: { write: () => Promise<unknown> }) => input.write(),
	),
}))

vi.mock('#worker/account/deletion-state.ts', () => ({
	withAccountWriteLease: mocks.withAccountWriteLease,
}))

vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EmailRepo>()
	return {
		...actual,
		insertEmailMessage: mocks.insertEmailMessage,
		insertEmailAttachments: mocks.insertEmailAttachments,
		deleteEmailMessageById: mocks.deleteEmailMessageById,
		getEmailMessageById: mocks.getEmailMessageById,
	}
})

const { insertEmailMessageWithAttachments, RetryableInboundStorageError } =
	await import('./service.ts')

test('attachment cleanup forwards optional Mailbox env and waitUntil to delete', async () => {
	const db = {} as D1Database
	const blobs = {
		put: vi.fn(async () => ({})),
		delete: vi.fn(async () => undefined),
	} as unknown as R2Bucket
	const env = { APP_DB: db } as Env
	const waitUntil = vi.fn()
	const storedMessage = {
		id: 'message-1',
		userId: 'user-1',
		direction: 'inbound' as const,
		rawMimeKey: 'email/user-1/message-1/raw.eml',
	}

	mocks.insertEmailMessage.mockResolvedValueOnce(storedMessage)
	mocks.insertEmailAttachments.mockRejectedValueOnce(
		new Error('simulated attachment insert failure'),
	)
	mocks.getEmailMessageById.mockResolvedValueOnce(null)

	await expect(
		insertEmailMessageWithAttachments({
			db,
			blobs,
			env,
			waitUntil,
			message: {
				id: 'message-1',
				direction: 'inbound',
				userId: 'user-1',
				rawMime: 'cleanup-bytes',
				processingStatus: 'stored',
			},
			attachments: [
				{
					filename: 'note.txt',
					contentType: 'text/plain',
					storageKind: 'raw-mime',
					storageKey: null,
				},
			],
		}),
	).rejects.toBeInstanceOf(RetryableInboundStorageError)

	expect(mocks.deleteEmailMessageById).toHaveBeenCalledWith({
		db,
		blobs,
		messageId: 'message-1',
		env,
		waitUntil,
	})
})

test('attachment cleanup without mirror context keeps acknowledge/retry rules', async () => {
	silenceExpectedConsoleErrors(['inbound-email-attachment-cleanup-failed'])
	const db = {} as D1Database
	const blobs = {
		put: vi.fn(async () => ({})),
		delete: vi.fn(async () => undefined),
	} as unknown as R2Bucket
	const remaining = {
		id: 'message-2',
		userId: 'user-2',
		direction: 'inbound' as const,
		rawMimeKey: 'email/user-2/message-2/raw.eml',
	}

	mocks.insertEmailMessage.mockResolvedValueOnce(remaining)
	mocks.insertEmailAttachments.mockRejectedValueOnce(
		new Error('simulated attachment insert failure'),
	)
	mocks.deleteEmailMessageById.mockRejectedValueOnce(
		new Error('simulated cleanup failure'),
	)
	mocks.getEmailMessageById.mockResolvedValueOnce(remaining)

	await expect(
		insertEmailMessageWithAttachments({
			db,
			blobs,
			message: {
				id: 'message-2',
				direction: 'inbound',
				userId: 'user-2',
				rawMime: 'orphan-bytes',
				processingStatus: 'stored',
			},
			attachments: [
				{
					filename: 'note.txt',
					contentType: 'text/plain',
					storageKind: 'raw-mime',
					storageKey: null,
				},
			],
		}),
	).resolves.toMatchObject({ id: 'message-2' })

	expect(mocks.deleteEmailMessageById).toHaveBeenCalledWith({
		db,
		blobs,
		messageId: 'message-2',
		env: undefined,
		waitUntil: undefined,
	})
})
