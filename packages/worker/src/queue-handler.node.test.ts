import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	handleEmailDeliveryQueue: vi.fn(),
	handlePlatformFeedbackDispatchQueue: vi.fn(),
}))

vi.mock('#worker/email/delivery-queue.ts', () => ({
	emailDeliveryQueueName: 'kody-email-delivery',
	handleEmailDeliveryQueue: mocks.handleEmailDeliveryQueue,
}))

vi.mock('#worker/platform-feedback/dispatch-queue.ts', () => ({
	handlePlatformFeedbackDispatchQueue:
		mocks.handlePlatformFeedbackDispatchQueue,
}))

const { handleQueueBatch } = await import('./queue-handler.ts')

function createBatch(queue: string) {
	return {
		queue,
		messages: [],
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<unknown>
}

test('worker queue routing isolates email, platform feedback, and unknown queues', async () => {
	consoleError.mockImplementation(() => {})
	const env = {} as Env
	const ctx = {} as ExecutionContext
	const emailBatch = createBatch('kody-email-delivery')
	const feedbackBatch = createBatch('kody-platform-feedback-dispatch')
	const unknownBatch = createBatch('unexpected-queue')

	await handleQueueBatch(emailBatch, env, ctx)
	await handleQueueBatch(feedbackBatch, env, ctx)
	await handleQueueBatch(unknownBatch, env, ctx)

	expect(mocks.handleEmailDeliveryQueue).toHaveBeenCalledTimes(1)
	expect(mocks.handleEmailDeliveryQueue).toHaveBeenCalledWith(
		emailBatch,
		env,
		ctx,
	)
	expect(mocks.handlePlatformFeedbackDispatchQueue).toHaveBeenCalledTimes(1)
	expect(mocks.handlePlatformFeedbackDispatchQueue).toHaveBeenCalledWith(
		feedbackBatch,
		env,
		ctx,
	)
	expect(unknownBatch.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith('unknown-worker-queue', {
		queue: 'unexpected-queue',
	})
})
