import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'

const mocks = vi.hoisted(() => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent: vi.fn(),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent:
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
}))

const { handlePlatformFeedbackDispatchQueue } =
	await import('./dispatch-queue.ts')

const feedbackId = 'feedback-1'

function createQueueMessage(id: string, body: unknown) {
	return {
		id,
		timestamp: new Date('2026-07-19T00:01:00.000Z'),
		body,
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}
}

function createBatch(messages: Array<ReturnType<typeof createQueueMessage>>) {
	return {
		queue: 'kody-platform-feedback-dispatch',
		messages,
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<unknown>
}

test('platform feedback queue acks valid, invalid, and cancelled messages and retries transient failures', async () => {
	consoleError.mockImplementation(() => {})
	const first = createQueueMessage('queue-valid', {
		feedbackId,
	})
	const duplicate = createQueueMessage('queue-duplicate', {
		feedbackId,
	})
	const missing = createQueueMessage('queue-missing', {})
	const invalid = createQueueMessage('queue-invalid', { feedbackId: '   ' })
	const extraFields = createQueueMessage('queue-extra-fields', {
		feedbackId,
		summary: 'must not cross the queue boundary',
	})
	const deleted = createQueueMessage('queue-deleted', {
		feedbackId: 'feedback-deleted',
	})
	const loadFailure = createQueueMessage('queue-load-failure', {
		feedbackId: 'feedback-load-failure',
	})
	const dispatchFailure = createQueueMessage('queue-dispatch-failure', {
		feedbackId,
	})
	mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new PlatformFeedbackDispatchCancelledError('feedback-deleted'),
		)
		.mockRejectedValueOnce(new Error('D1 lookup unavailable'))
		.mockRejectedValueOnce(new Error('subscription wrapper unavailable'))

	await handlePlatformFeedbackDispatchQueue(
		createBatch([
			first,
			duplicate,
			missing,
			invalid,
			extraFields,
			deleted,
			loadFailure,
			dispatchFailure,
		]),
		{ APP_DB: {} } as Env,
		{} as ExecutionContext,
	)

	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenCalledTimes(5)
	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		feedbackId,
	})
	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenNthCalledWith(2, {
		env: expect.anything(),
		feedbackId,
	})
	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenNthCalledWith(3, {
		env: expect.anything(),
		feedbackId: 'feedback-deleted',
	})
	for (const message of [
		first,
		duplicate,
		missing,
		invalid,
		extraFields,
		deleted,
	]) {
		expect(message.ack).toHaveBeenCalledTimes(1)
		expect(message.retry).not.toHaveBeenCalled()
	}
	for (const message of [loadFailure, dispatchFailure]) {
		expect(message.ack).not.toHaveBeenCalled()
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	}
	expect(consoleError).toHaveBeenCalledTimes(2)
	expect(consoleError).toHaveBeenCalledWith(
		'platform-feedback-dispatch-queue-processing-failed',
		expect.objectContaining({
			queueMessageId: 'queue-load-failure',
			feedbackId: 'feedback-load-failure',
			error: expect.any(Error),
		}),
	)
})
