import { expect, test, vi } from 'vitest'
import { systemEmailOwnerId } from './email-owner.ts'

const mocks = vi.hoisted(() => ({
	setMessageClassification: vi.fn(),
	updateSystemEmailMessageClassification: vi.fn(),
}))

vi.mock('./mailbox-client.ts', () => ({
	mailboxRpc: () => ({
		setMessageClassification: mocks.setMessageClassification,
	}),
}))

vi.mock('./system-email-graph-store.ts', () => ({
	updateSystemEmailMessageClassification:
		mocks.updateSystemEmailMessageClassification,
}))

const { setEmailMessageClassification } = await import('./service.ts')

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

test('setEmailMessageClassification mutates the owner Mailbox without preparing USER graph SQL', async () => {
	const { env, preparedSql } = createEnv()
	mocks.setMessageClassification.mockResolvedValue({
		status: 'accepted',
	})

	await expect(
		setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: 'user-1',
			messageId: 'message-1',
			classification: 'quarantined',
			classificationReason: 'Reclassified by user.',
		}),
	).resolves.toBe(true)

	expect(mocks.setMessageClassification).toHaveBeenCalledWith({
		ownerId: 'user-1',
		messageId: 'message-1',
		classification: 'quarantined',
		classificationReason: 'Reclassified by user.',
		updatedAt: expect.any(String),
	})
	expectOnlyAuthorityMarkerSql(preparedSql)
})

test('setEmailMessageClassification reports missing Mailbox messages', async () => {
	const { env, preparedSql } = createEnv()
	mocks.setMessageClassification.mockResolvedValueOnce({ status: 'missing' })

	await expect(
		setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: 'user-1',
			messageId: 'missing',
			classification: 'accepted',
			classificationReason: null,
		}),
	).resolves.toBe(false)

	expectOnlyAuthorityMarkerSql(preparedSql)
})

test('setEmailMessageClassification preserves the dedicated system graph path', async () => {
	const { env } = createEnv()
	mocks.updateSystemEmailMessageClassification.mockResolvedValueOnce(true)

	await expect(
		setEmailMessageClassification({
			env,
			db: env.APP_DB,
			userId: systemEmailOwnerId,
			messageId: 'message-1',
			classification: 'quarantined',
			classificationReason: 'Reclassified by user.',
		}),
	).resolves.toBe(true)

	expect(mocks.updateSystemEmailMessageClassification).toHaveBeenCalledWith({
		db: env.APP_DB,
		messageId: 'message-1',
		classification: 'quarantined',
		classificationReason: 'Reclassified by user.',
		now: undefined,
	})
})
