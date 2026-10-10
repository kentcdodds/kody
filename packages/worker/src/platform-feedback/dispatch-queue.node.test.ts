import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'

const mocks = vi.hoisted(() => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent: vi.fn(),
	getPlatformFeedbackForAdmin: vi.fn(),
	sendPlatformFeedbackAcknowledgementEmail: vi.fn(),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchPlatformFeedbackSubmittedSubscriptionEvent:
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
}))

vi.mock('./service.ts', () => ({
	getPlatformFeedbackForAdmin: (...args: Array<unknown>) =>
		mocks.getPlatformFeedbackForAdmin(...args),
}))

vi.mock('./acknowledgement-email.ts', () => ({
	sendPlatformFeedbackAcknowledgementEmail: (...args: Array<unknown>) =>
		mocks.sendPlatformFeedbackAcknowledgementEmail(...args),
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
	const first = createQueueMessage('queue-valid', { feedbackId })
	const duplicate = createQueueMessage('queue-duplicate', { feedbackId })
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
	mocks.getPlatformFeedbackForAdmin.mockResolvedValue({
		id: feedbackId,
		submitterUserId: 'user-1',
		status: 'open',
	})
	mocks.sendPlatformFeedbackAcknowledgementEmail.mockResolvedValue(true)
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
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent.mock.calls,
	).toEqual(
		[
			feedbackId,
			feedbackId,
			'feedback-deleted',
			'feedback-load-failure',
			feedbackId,
		].map((id) => [{ env: expect.anything(), feedbackId: id }]),
	)
	expect(mocks.sendPlatformFeedbackAcknowledgementEmail).toHaveBeenCalled()
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

test('platform feedback queue keeps admin dispatch moving when acknowledgement fails', async () => {
	consoleWarn.mockImplementation(() => {})
	const message = createQueueMessage('queue-ack-fail', { feedbackId })
	mocks.getPlatformFeedbackForAdmin.mockResolvedValue({
		id: feedbackId,
		submitterUserId: 'user-1',
		status: 'open',
	})
	mocks.sendPlatformFeedbackAcknowledgementEmail.mockRejectedValue(
		new Error('smtp hung then threw'),
	)
	mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent.mockResolvedValue([])

	await handlePlatformFeedbackDispatchQueue(
		createBatch([message]),
		{ APP_DB: {} } as Env,
		{} as ExecutionContext,
	)

	expect(
		mocks.dispatchPlatformFeedbackSubmittedSubscriptionEvent,
	).toHaveBeenCalledWith({ env: expect.anything(), feedbackId })
	expect(message.ack).toHaveBeenCalledTimes(1)
	expect(message.retry).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'platform-feedback-acknowledgement-email-failed',
		{
			feedbackId,
			error: expect.any(Error),
		},
	)
})
