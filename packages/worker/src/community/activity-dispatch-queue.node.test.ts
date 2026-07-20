import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { CommunityActivityDispatchCancelledError } from './errors.ts'

const mocks = vi.hoisted(() => ({
	dispatchCommunityActivityRecordedSubscriptionEvent: vi.fn(),
}))

vi.mock('./activity-package-subscriptions.ts', () => ({
	dispatchCommunityActivityRecordedSubscriptionEvent:
		mocks.dispatchCommunityActivityRecordedSubscriptionEvent,
}))

const { handleCommunityActivityDispatchQueue } =
	await import('./activity-dispatch-queue.ts')

function createQueueMessage(id: string, body: unknown) {
	return {
		id,
		timestamp: new Date('2026-07-20T01:01:00.000Z'),
		body,
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}
}

function createBatch(messages: Array<ReturnType<typeof createQueueMessage>>) {
	return {
		queue: 'kody-community-activity-dispatch',
		messages,
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<unknown>
}

test('community activity queue acks valid, invalid, and cancelled messages and retries transient failures', async () => {
	consoleError.mockImplementation(() => {})
	const valid = createQueueMessage('valid', {
		eventId: 'event-1',
		kind: 'fork',
		activityId: 'fork-1',
	})
	const invalidKind = createQueueMessage('invalid-kind', {
		eventId: 'event-2',
		kind: 'install',
		activityId: 'fork-2',
	})
	const extra = createQueueMessage('extra', {
		eventId: 'event-3',
		kind: 'rating',
		activityId: 'rating-1',
		stars: 5,
	})
	const deleted = createQueueMessage('deleted', {
		eventId: 'event-4',
		kind: 'rating',
		activityId: 'rating-deleted',
	})
	const transient = createQueueMessage('transient', {
		eventId: 'event-5',
		kind: 'rating',
		activityId: 'rating-2',
	})
	mocks.dispatchCommunityActivityRecordedSubscriptionEvent
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new CommunityActivityDispatchCancelledError({
				kind: 'rating',
				activityId: 'rating-deleted',
			}),
		)
		.mockRejectedValueOnce(new Error('D1 unavailable'))

	await handleCommunityActivityDispatchQueue(
		createBatch([valid, invalidKind, extra, deleted, transient]),
		{ APP_DB: {} } as Env,
		{} as ExecutionContext,
	)

	expect(
		mocks.dispatchCommunityActivityRecordedSubscriptionEvent,
	).toHaveBeenCalledTimes(3)
	expect(
		mocks.dispatchCommunityActivityRecordedSubscriptionEvent,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		eventId: 'event-1',
		kind: 'fork',
		activityId: 'fork-1',
	})
	for (const message of [valid, invalidKind, extra, deleted]) {
		expect(message.ack).toHaveBeenCalledTimes(1)
		expect(message.retry).not.toHaveBeenCalled()
	}
	expect(transient.ack).not.toHaveBeenCalled()
	expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'community-activity-dispatch-queue-processing-failed',
		expect.objectContaining({
			queueMessageId: 'transient',
			eventId: 'event-5',
			kind: 'rating',
			activityId: 'rating-2',
			error: expect.any(Error),
		}),
	)
})
