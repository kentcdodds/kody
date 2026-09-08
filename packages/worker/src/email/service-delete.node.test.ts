import { expect, test, vi } from 'vitest'
import { systemEmailOwnerId } from './email-owner.ts'

const mocks = vi.hoisted(() => ({
	deleteMessageWithBlobs: vi.fn(),
	deleteOutboundProviderIndexByMessageId: vi.fn(),
}))

vi.mock('./mailbox-client.ts', () => ({
	mailboxRpc: () => ({
		deleteMessageWithBlobs: mocks.deleteMessageWithBlobs,
	}),
}))

vi.mock('./outbound-provider-index.ts', () => ({
	deleteOutboundProviderIndexByMessageId:
		mocks.deleteOutboundProviderIndexByMessageId,
	getOutboundProviderIndexRow: vi.fn(),
}))

const { deleteEmailMessage } = await import('./service.ts')

function resetMocks() {
	mocks.deleteMessageWithBlobs.mockReset()
	mocks.deleteOutboundProviderIndexByMessageId.mockReset()
}

function createEnv() {
	const preparedSql: Array<string> = []
	const first = vi.fn(async () => ({
		owner_count: 1,
		frozen_at: '2026-08-03T00:00:00.000Z',
		max_parity_age_hours: 6,
	}))
	const prepare = vi.fn((sql: string) => {
		preparedSql.push(sql)
		return { first }
	})
	const env = {
		APP_DB: { prepare } as unknown as D1Database,
	} as Env
	return { env, preparedSql }
}

function expectOnlyAuthorityMarkerSql(preparedSql: ReadonlyArray<string>) {
	expect(preparedSql).toHaveLength(1)
	expect(preparedSql[0]).toContain('email_user_graph_authority')
	expect(preparedSql[0]).not.toMatch(
		/\bemail_(?:threads|messages|attachments|delivery_events)\b/,
	)
}

test('deleteEmailMessage deletes the owner Mailbox message and outbound index', async () => {
	resetMocks()
	const { env, preparedSql } = createEnv()
	mocks.deleteMessageWithBlobs.mockResolvedValueOnce({
		status: 'deleted',
		providerMessageId: 'cf-1',
		attachmentsSeen: 0,
		externalAttachmentsSeen: 0,
		blobReferences: [],
	})
	mocks.deleteOutboundProviderIndexByMessageId.mockResolvedValueOnce(1)

	await expect(
		deleteEmailMessage({
			env,
			db: env.APP_DB,
			userId: 'user-1',
			messageId: 'message-1',
		}),
	).resolves.toBe(true)

	expect(mocks.deleteMessageWithBlobs).toHaveBeenCalledWith({
		ownerId: 'user-1',
		messageId: 'message-1',
	})
	expect(mocks.deleteOutboundProviderIndexByMessageId).toHaveBeenCalledWith({
		db: env.APP_DB,
		messageId: 'message-1',
	})
	expectOnlyAuthorityMarkerSql(preparedSql)
})

test('deleteEmailMessage reports missing and foreign Mailbox messages', async () => {
	resetMocks()
	const { env, preparedSql } = createEnv()
	mocks.deleteMessageWithBlobs.mockResolvedValueOnce({
		status: 'missing',
		tombstoned: false,
	})

	await expect(
		deleteEmailMessage({
			env,
			db: env.APP_DB,
			userId: 'user-1',
			messageId: 'foreign-or-missing',
		}),
	).resolves.toBe(false)

	expect(mocks.deleteOutboundProviderIndexByMessageId).not.toHaveBeenCalled()
	expectOnlyAuthorityMarkerSql(preparedSql)
})

test('deleteEmailMessage refuses the system inbox owner', async () => {
	resetMocks()
	const { env } = createEnv()

	await expect(
		deleteEmailMessage({
			env,
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			messageId: 'message-1',
		}),
	).rejects.toThrow(
		'System inbox messages cannot be deleted through the user email store.',
	)
	expect(mocks.deleteMessageWithBlobs).not.toHaveBeenCalled()
})
