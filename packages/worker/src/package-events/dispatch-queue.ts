import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { deliverPackageEvent } from '#worker/package-invocations/service.ts'
import { parsePackageEventsDispatchQueueMessage } from './dispatch-queue-producer.ts'

const packageEventsDispatchRetryDelaySeconds = 30

export async function handlePackageEventsDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	const baseUrl = getAppBaseUrl({ env })
	for (const queueMessage of batch.messages) {
		const message = parsePackageEventsDispatchQueueMessage(queueMessage.body)
		if (!message) {
			console.error('package-events-dispatch-message-invalid', {
				queueMessageId: queueMessage.id,
			})
			queueMessage.ack()
			continue
		}
		try {
			const result = await deliverPackageEvent({
				env,
				baseUrl,
				message,
				waitUntil: (promise) => ctx.waitUntil(promise),
			})
			// Terminal handler failures are final for this delivery: the
			// idempotency ledger would replay the stored failure on retry, so
			// redelivery cannot help. They stay visible in each subscriber's
			// run records.
			if (result.failed > 0) {
				console.error('package-events-dispatch-subscribers-failed', {
					queueMessageId: queueMessage.id,
					topic: message.topic,
					sourcePackageId: message.source.packageId,
					failed: result.failed,
					delivered: result.delivered,
				})
			}
			queueMessage.ack()
		} catch (error) {
			console.error('package-events-dispatch-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				topic: message.topic,
				sourcePackageId: message.source.packageId,
				error,
			})
			queueMessage.retry({
				delaySeconds: packageEventsDispatchRetryDelaySeconds,
			})
		}
	}
}
