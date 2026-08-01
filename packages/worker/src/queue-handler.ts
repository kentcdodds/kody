import {
	emailDeliveryQueueName,
	handleEmailDeliveryQueue,
} from '#worker/email/delivery-queue.ts'
import { handleCommunityActivityDispatchQueue } from '#worker/community/activity-dispatch-queue.ts'
import { communityActivityDispatchQueueName } from '#worker/community/activity-dispatch-queue-names.ts'
import { handlePlatformFeedbackDispatchQueue } from '#worker/platform-feedback/dispatch-queue.ts'
import { platformFeedbackDispatchQueueName } from '#worker/platform-feedback/dispatch-queue-names.ts'
import { handleScheduledDispatchQueue } from '#worker/scheduled/scheduled-dispatch-queue.ts'
import { scheduledDispatchQueueName } from '#worker/scheduled/scheduled-dispatch-queue-names.ts'

const unknownQueueRetryDelaySeconds = 30

export async function handleQueueBatch(
	batch: MessageBatch<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	switch (batch.queue) {
		case emailDeliveryQueueName:
			await handleEmailDeliveryQueue(batch, env, ctx)
			return
		case platformFeedbackDispatchQueueName:
			await handlePlatformFeedbackDispatchQueue(batch, env, ctx)
			return
		case communityActivityDispatchQueueName:
			await handleCommunityActivityDispatchQueue(batch, env, ctx)
			return
		case scheduledDispatchQueueName:
			await handleScheduledDispatchQueue(batch, env, ctx)
			return
		default:
			console.error('unknown-worker-queue', { queue: batch.queue })
			batch.retryAll({ delaySeconds: unknownQueueRetryDelaySeconds })
	}
}
