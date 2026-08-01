import { expect, test, vi } from 'vitest'
import { emailRawMimeKey } from './blob-keys.ts'

const mocks = vi.hoisted(() => ({
	mirrorMailboxDeleteMessageMetadata: vi.fn(async () => ({
		status: 'mirrored' as const,
	})),
}))

vi.mock('./mailbox-mirror.ts', () => ({
	mirrorMailboxDeleteMessageMetadata: mocks.mirrorMailboxDeleteMessageMetadata,
}))

const { deleteEmailMessageById } = await import('./repo.ts')

function createDeleteHarness(input?: {
	userId?: string | null
	attachmentKeys?: Array<string>
	batchError?: Error
}) {
	const userId = input?.userId === undefined ? 'user-1' : input.userId
	const attachmentKeys = input?.attachmentKeys ?? ['attachments/user-1/a1']
	const callOrder: Array<string> = []
	const deletedBlobKeys: Array<string> = []

	const selectUser = {
		bind: vi.fn(() => ({
			first: vi.fn(async () => (userId == null ? null : { user_id: userId })),
		})),
	}
	const selectAttachments = {
		bind: vi.fn(() => ({
			all: vi.fn(async () => ({
				results: attachmentKeys.map((storage_key) => ({ storage_key })),
			})),
		})),
	}
	const deleteAttachments = {
		bind: vi.fn(() => ({ kind: 'delete-attachments' })),
	}
	const deleteMessage = {
		bind: vi.fn(() => ({ kind: 'delete-message' })),
	}

	let prepareCalls = 0
	const db = {
		prepare: vi.fn((sql: string) => {
			prepareCalls += 1
			if (sql.includes('SELECT user_id')) return selectUser
			if (sql.includes('SELECT storage_key')) return selectAttachments
			if (sql.includes('DELETE FROM email_attachments'))
				return deleteAttachments
			if (sql.includes('DELETE FROM email_messages')) return deleteMessage
			throw new Error(`unexpected prepare: ${sql}`)
		}),
		batch: vi.fn(async () => {
			callOrder.push('d1-batch')
			if (input?.batchError) throw input.batchError
			return []
		}),
	} as unknown as D1Database

	const blobs = {
		delete: vi.fn(async (key: string) => {
			callOrder.push(`r2:${key}`)
			deletedBlobKeys.push(key)
		}),
	} as unknown as R2Bucket

	const env = { APP_DB: db } as unknown as Env

	return {
		db,
		blobs,
		env,
		callOrder,
		deletedBlobKeys,
		prepareCalls: () => prepareCalls,
		messageId: 'message-1',
		userId,
		attachmentKeys,
	}
}

test('deleteEmailMessageById keeps D1-then-R2 order and mirrors only after D1', async () => {
	const harness = createDeleteHarness()
	mocks.mirrorMailboxDeleteMessageMetadata.mockImplementation(async () => {
		harness.callOrder.push('mirror')
		return { status: 'mirrored' }
	})

	await deleteEmailMessageById({
		db: harness.db,
		blobs: harness.blobs,
		messageId: harness.messageId,
		env: harness.env,
	})

	expect(harness.callOrder[0]).toBe('d1-batch')
	expect(harness.callOrder[1]).toBe('mirror')
	expect(harness.callOrder.slice(2)).toEqual([
		`r2:${emailRawMimeKey('user-1', harness.messageId)}`,
		'r2:attachments/user-1/a1',
	])
	expect(mocks.mirrorMailboxDeleteMessageMetadata).toHaveBeenCalledTimes(1)
	expect(mocks.mirrorMailboxDeleteMessageMetadata).toHaveBeenCalledWith({
		env: harness.env,
		ownerId: 'user-1',
		messageId: harness.messageId,
		deletedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
	})
	expect(harness.deletedBlobKeys).toEqual([
		emailRawMimeKey('user-1', harness.messageId),
		'attachments/user-1/a1',
	])
})

test('deleteEmailMessageById without mirror env preserves D1/R2 behavior and skips DO delete', async () => {
	const harness = createDeleteHarness()

	await deleteEmailMessageById({
		db: harness.db,
		blobs: harness.blobs,
		messageId: harness.messageId,
	})

	expect(harness.callOrder).toEqual([
		'd1-batch',
		`r2:${emailRawMimeKey('user-1', harness.messageId)}`,
		'r2:attachments/user-1/a1',
	])
	expect(mocks.mirrorMailboxDeleteMessageMetadata).not.toHaveBeenCalled()
})

test('deleteEmailMessageById skips mirror when the message row is absent', async () => {
	const harness = createDeleteHarness({ userId: null, attachmentKeys: [] })

	await deleteEmailMessageById({
		db: harness.db,
		blobs: harness.blobs,
		messageId: harness.messageId,
		env: harness.env,
	})

	expect(harness.callOrder).toEqual(['d1-batch'])
	expect(mocks.mirrorMailboxDeleteMessageMetadata).not.toHaveBeenCalled()
	expect(harness.deletedBlobKeys).toEqual([])
})

test('deleteEmailMessageById never throws when mirror reports failure or timeout', async () => {
	const harness = createDeleteHarness({ attachmentKeys: [] })
	mocks.mirrorMailboxDeleteMessageMetadata
		.mockResolvedValueOnce({
			status: 'error',
			error: new Error('mailbox delete mirror failed'),
		})
		.mockResolvedValueOnce({ status: 'timeout' })

	await expect(
		deleteEmailMessageById({
			db: harness.db,
			blobs: harness.blobs,
			messageId: harness.messageId,
			env: harness.env,
		}),
	).resolves.toBeUndefined()

	await expect(
		deleteEmailMessageById({
			db: harness.db,
			blobs: harness.blobs,
			messageId: harness.messageId,
			env: harness.env,
		}),
	).resolves.toBeUndefined()

	expect(harness.deletedBlobKeys).toEqual([
		emailRawMimeKey('user-1', harness.messageId),
		emailRawMimeKey('user-1', harness.messageId),
	])
})

test('deleteEmailMessageById schedules mirror via waitUntil without awaiting before R2', async () => {
	const harness = createDeleteHarness({ attachmentKeys: [] })
	let resolveMirror!: (value: { status: 'mirrored' }) => void
	const mirrorPromise = new Promise<{ status: 'mirrored' }>((resolve) => {
		resolveMirror = resolve
	})
	mocks.mirrorMailboxDeleteMessageMetadata.mockReturnValueOnce(mirrorPromise)

	const waitUntilPromises: Array<Promise<unknown>> = []
	const waitUntil = vi.fn((promise: Promise<unknown>) => {
		waitUntilPromises.push(promise)
	})

	const pending = deleteEmailMessageById({
		db: harness.db,
		blobs: harness.blobs,
		messageId: harness.messageId,
		env: harness.env,
		waitUntil,
	})

	await expect(pending).resolves.toBeUndefined()
	expect(waitUntil).toHaveBeenCalledTimes(1)
	expect(harness.callOrder).toEqual([
		'd1-batch',
		`r2:${emailRawMimeKey('user-1', harness.messageId)}`,
	])
	expect(harness.deletedBlobKeys).toEqual([
		emailRawMimeKey('user-1', harness.messageId),
	])

	resolveMirror({ status: 'mirrored' })
	await Promise.all(waitUntilPromises)
	expect(mocks.mirrorMailboxDeleteMessageMetadata).toHaveBeenCalledTimes(1)
})

test('deleteEmailMessageById does not mirror when D1 batch fails', async () => {
	const harness = createDeleteHarness({
		batchError: new Error('simulated d1 batch failure'),
	})

	await expect(
		deleteEmailMessageById({
			db: harness.db,
			blobs: harness.blobs,
			messageId: harness.messageId,
			env: harness.env,
		}),
	).rejects.toThrow('simulated d1 batch failure')

	expect(mocks.mirrorMailboxDeleteMessageMetadata).not.toHaveBeenCalled()
	expect(harness.deletedBlobKeys).toEqual([])
	expect(harness.callOrder).toEqual(['d1-batch'])
})
