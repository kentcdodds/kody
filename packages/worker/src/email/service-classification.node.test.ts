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
	return {
		APP_DB: { prepare: vi.fn() } as unknown as D1Database,
	} as Env
}

test('setEmailMessageClassification mutates the owner Mailbox without preparing USER graph SQL', async () => {
	const env = createEnv()
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
	expect(env.APP_DB.prepare).not.toHaveBeenCalled()
})

test('setEmailMessageClassification reports missing Mailbox messages', async () => {
	const env = createEnv()
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

	expect(env.APP_DB.prepare).not.toHaveBeenCalled()
})

test('setEmailMessageClassification preserves the dedicated system graph path', async () => {
	const env = createEnv()
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
