import { dispatchPlatformFeedbackSubmittedSubscriptionEvent } from './package-subscriptions.ts'
import { type PlatformFeedbackDispatchQueueMessage } from './dispatch-queue-producer.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'

const platformFeedbackDispatchRetryDelaySeconds = 30

function parsePlatformFeedbackDispatchQueueMessage(
	body: unknown,
): PlatformFeedbackDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const feedbackId = record['feedbackId']
	if (
		Object.keys(record).length !== 1 ||
		typeof feedbackId !== 'string' ||
		!feedbackId.trim()
	) {
		return null
	}
	return { feedbackId: feedbackId.trim() }
}

export async function handlePlatformFeedbackDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
) {
	for (const queueMessage of batch.messages) {
		const parsed = parsePlatformFeedbackDispatchQueueMessage(queueMessage.body)
		if (!parsed) {
			queueMessage.ack()
			continue
		}
		try {
			await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
				env,
				feedbackId: parsed.feedbackId,
			})
			queueMessage.ack()
		} catch (error) {
			if (error instanceof PlatformFeedbackDispatchCancelledError) {
				queueMessage.ack()
				continue
			}
			console.error('platform-feedback-dispatch-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				feedbackId: parsed.feedbackId,
				error,
			})
			queueMessage.retry({
				delaySeconds: platformFeedbackDispatchRetryDelaySeconds,
			})
		}
	}
}
