import { expect, test, vi } from 'vitest'
import { packageEventsDispatchQueueName } from '#worker/package-events/dispatch-queue-names.ts'
import { scheduledDispatchQueueName } from '#worker/scheduled/scheduled-dispatch-queue-names.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	handleCommunityActivityDispatchQueue: vi.fn(),
	handleEmailDeliveryQueue: vi.fn(),
	handleArtifactsRepoEventsQueue: vi.fn(),
	handlePackageEventsDispatchQueue: vi.fn(),
	handlePlatformFeedbackDispatchQueue: vi.fn(),
	handleScheduledDispatchQueue: vi.fn(),
}))

vi.mock('#worker/community/activity-dispatch-queue.ts', () => ({
	handleCommunityActivityDispatchQueue:
		mocks.handleCommunityActivityDispatchQueue,
}))

vi.mock('#worker/community/activity-dispatch-queue-names.ts', () => ({
	communityActivityDispatchQueueName: 'kody-community-activity-dispatch',
}))

vi.mock('#worker/email/delivery-queue.ts', () => ({
	emailDeliveryQueueName: 'kody-email-delivery',
	handleEmailDeliveryQueue: mocks.handleEmailDeliveryQueue,
}))

vi.mock('#worker/repo/artifacts-event-queue.ts', () => ({
	artifactsRepoEventsQueueName: 'kody-artifacts-repo-events',
	handleArtifactsRepoEventsQueue: mocks.handleArtifactsRepoEventsQueue,
}))

vi.mock('#worker/package-events/dispatch-queue.ts', () => ({
	handlePackageEventsDispatchQueue: mocks.handlePackageEventsDispatchQueue,
}))

vi.mock('#worker/platform-feedback/dispatch-queue.ts', () => ({
	handlePlatformFeedbackDispatchQueue:
		mocks.handlePlatformFeedbackDispatchQueue,
}))

vi.mock('#worker/scheduled/scheduled-dispatch-queue.ts', () => ({
	handleScheduledDispatchQueue: mocks.handleScheduledDispatchQueue,
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

test('worker queue routing isolates known queues and retries unknown queues', async () => {
	consoleError.mockImplementation(() => {})
	const env = {} as Env
	const ctx = {} as ExecutionContext
	const emailBatch = createBatch('kody-email-delivery')
	const artifactsBatch = createBatch('kody-artifacts-repo-events')
	const feedbackBatch = createBatch('kody-platform-feedback-dispatch')
	const communityActivityBatch = createBatch('kody-community-activity-dispatch')
	const packageEventsBatch = createBatch(packageEventsDispatchQueueName)
	const scheduledBatch = createBatch(scheduledDispatchQueueName)
	const unknownBatch = createBatch('unexpected-queue')

	await handleQueueBatch(emailBatch, env, ctx)
	await handleQueueBatch(artifactsBatch, env, ctx)
	await handleQueueBatch(feedbackBatch, env, ctx)
	await handleQueueBatch(communityActivityBatch, env, ctx)
	await handleQueueBatch(packageEventsBatch, env, ctx)
	await handleQueueBatch(scheduledBatch, env, ctx)
	await handleQueueBatch(unknownBatch, env, ctx)

	expect(mocks.handleEmailDeliveryQueue).toHaveBeenCalledTimes(1)
	expect(mocks.handleEmailDeliveryQueue).toHaveBeenCalledWith(
		emailBatch,
		env,
		ctx,
	)
	expect(mocks.handleArtifactsRepoEventsQueue).toHaveBeenCalledWith(
		artifactsBatch,
		env,
		ctx,
	)
	expect(mocks.handlePlatformFeedbackDispatchQueue).toHaveBeenCalledTimes(1)
	expect(mocks.handlePlatformFeedbackDispatchQueue).toHaveBeenCalledWith(
		feedbackBatch,
		env,
		ctx,
	)
	expect(mocks.handleCommunityActivityDispatchQueue).toHaveBeenCalledTimes(1)
	expect(mocks.handleCommunityActivityDispatchQueue).toHaveBeenCalledWith(
		communityActivityBatch,
		env,
		ctx,
	)
	expect(mocks.handlePackageEventsDispatchQueue).toHaveBeenCalledTimes(1)
	expect(mocks.handlePackageEventsDispatchQueue).toHaveBeenCalledWith(
		packageEventsBatch,
		env,
		ctx,
	)
	expect(mocks.handleScheduledDispatchQueue).toHaveBeenCalledWith(
		scheduledBatch,
		env,
		ctx,
	)
	expect(unknownBatch.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(consoleError).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith('unknown-worker-queue', {
		queue: 'unexpected-queue',
	})
})
