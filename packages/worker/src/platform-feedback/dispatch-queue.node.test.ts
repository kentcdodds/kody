import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent: vi.fn(),
	getPlatformFeedbackForAdmin: vi.fn(),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent:
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
}))

vi.mock('./service.ts', () => ({
	getPlatformFeedbackForAdmin: mocks.getPlatformFeedbackForAdmin,
}))

const { handlePlatformFeedbackDispatchQueue } =
	await import('./dispatch-queue.ts')

const openFeedback = {
	id: 'feedback-1',
	submitterUserId: 'submitter-1',
	category: 'bug' as const,
	summary: 'The button does not save',
	details: 'Full user-authored details stay in D1.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T00:00:00.000Z',
}

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

test('platform feedback queue dispatches valid and duplicate messages while acknowledging permanent misses', async () => {
	const first = createQueueMessage('queue-valid', {
		feedbackId: openFeedback.id,
	})
	const duplicate = createQueueMessage('queue-duplicate', {
		feedbackId: openFeedback.id,
	})
	const missing = createQueueMessage('queue-missing', {})
	const invalid = createQueueMessage('queue-invalid', { feedbackId: '   ' })
	const extraFields = createQueueMessage('queue-extra-fields', {
		feedbackId: openFeedback.id,
		summary: 'must not cross the queue boundary',
	})
	const deleted = createQueueMessage('queue-deleted', {
		feedbackId: 'feedback-deleted',
	})
	mocks.getPlatformFeedbackForAdmin.mockImplementation(
		async (input: { feedbackId: string }) =>
			input.feedbackId === 'feedback-deleted' ? null : openFeedback,
	)
	mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent.mockResolvedValue([])

	await handlePlatformFeedbackDispatchQueue(
		createBatch([first, duplicate, missing, invalid, extraFields, deleted]),
		{ APP_DB: {} } as Env,
		{} as ExecutionContext,
	)

	expect(mocks.getPlatformFeedbackForAdmin).toHaveBeenCalledTimes(3)
	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenCalledTimes(2)
	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		feedback: openFeedback,
	})
	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenNthCalledWith(2, {
		env: expect.anything(),
		feedback: openFeedback,
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
})

test('platform feedback queue retries load and subscription wrapper failures after thirty seconds', async () => {
	consoleError.mockImplementation(() => {})
	const loadFailure = createQueueMessage('queue-load-failure', {
		feedbackId: 'feedback-load-failure',
	})
	const dispatchFailure = createQueueMessage('queue-dispatch-failure', {
		feedbackId: openFeedback.id,
	})
	mocks.getPlatformFeedbackForAdmin
		.mockRejectedValueOnce(new Error('D1 unavailable'))
		.mockResolvedValueOnce(openFeedback)
	mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent.mockRejectedValueOnce(
		new Error('subscription wrapper unavailable'),
	)

	await handlePlatformFeedbackDispatchQueue(
		createBatch([loadFailure, dispatchFailure]),
		{ APP_DB: {} } as Env,
		{} as ExecutionContext,
	)

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
