import { expect, test, vi } from 'vitest'
import type * as EmailRepo from './repo.ts'

const mocks = vi.hoisted(() => ({
	updateEmailMessageClassificationInD1: vi.fn(),
	mirrorMailboxMessageGraphFromD1: vi.fn(async () => ({
		messageId: 'message-1',
		message: { status: 'mirrored' as const },
		events: [],
	})),
}))

vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EmailRepo>()
	return {
		...actual,
		updateEmailMessageClassificationInD1:
			mocks.updateEmailMessageClassificationInD1,
	}
})

vi.mock('./mailbox-live-mirror.ts', () => ({
	mirrorMailboxMessageGraphFromD1: mocks.mirrorMailboxMessageGraphFromD1,
}))

const { setEmailMessageClassification } = await import('./service.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
	} as Env
}

test('setEmailMessageClassification mutates D1 then mirrors only on success', async () => {
	const env = createEnv()
	const callOrder: Array<string> = []
	mocks.updateEmailMessageClassificationInD1.mockImplementation(async () => {
		callOrder.push('d1')
		return true
	})
	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(async () => {
		callOrder.push('mirror')
		return {
			messageId: 'message-1',
			message: { status: 'mirrored' as const },
			events: [],
		}
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

	expect(callOrder).toEqual(['d1', 'mirror'])
	expect(mocks.updateEmailMessageClassificationInD1).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'user-1',
		messageId: 'message-1',
		classification: 'quarantined',
		classificationReason: 'Reclassified by user.',
		now: undefined,
	})
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledWith({
		env,
		db: env.APP_DB,
		userId: 'user-1',
		messageId: 'message-1',
	})
})

test('setEmailMessageClassification skips mirror when D1 updates nothing', async () => {
	const env = createEnv()
	mocks.updateEmailMessageClassificationInD1.mockResolvedValueOnce(false)
	mocks.mirrorMailboxMessageGraphFromD1.mockClear()

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

	expect(mocks.mirrorMailboxMessageGraphFromD1).not.toHaveBeenCalled()
})

test('setEmailMessageClassification still returns true when mirror reports error', async () => {
	const env = createEnv()
	mocks.updateEmailMessageClassificationInD1.mockResolvedValueOnce(true)
	mocks.mirrorMailboxMessageGraphFromD1.mockResolvedValueOnce({
		messageId: 'message-1',
		message: {
			status: 'error',
			error: new Error('mailbox mirror timed out'),
		},
		events: [],
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
})
