import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { dispatchEmailDeliverySubscriptionEvents } from './package-subscriptions.ts'

const unmatchedRetryDelaySeconds = 30

export async function handleEmailDeliveryQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	for (const queueMessage of batch.messages) {
		try {
			const result = await processCloudflareEmailDeliveryEvent({
				db: env.APP_DB,
				body: queueMessage.body,
			})
			switch (result.outcome) {
				case 'invalid':
					queueMessage.ack()
					break
				case 'unmatched':
					console.warn('email-delivery-event-unmatched', {
						queueMessageId: queueMessage.id,
						providerMessageId: result.event?.payload.messageId ?? null,
					})
					queueMessage.retry({ delaySeconds: unmatchedRetryDelaySeconds })
					break
				case 'duplicate':
					queueMessage.ack()
					break
				case 'recorded': {
					queueMessage.ack()
					const dispatch = dispatchEmailDeliverySubscriptionEvents({
						env,
						message: result.message,
						providerEvent: result.event,
					}).catch((error: unknown) => {
						console.error('email-delivery-subscription-dispatch-failed', error)
					})
					ctx.waitUntil(dispatch)
					break
				}
				default: {
					const exhaustive: never = result
					throw new Error(
						`Unsupported email delivery queue outcome: ${JSON.stringify(exhaustive)}`,
					)
				}
			}
		} catch (error) {
			console.error('email-delivery-event-processing-failed', error)
			queueMessage.retry({ delaySeconds: unmatchedRetryDelaySeconds })
		}
	}
}
