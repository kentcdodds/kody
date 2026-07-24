import { processCloudflareEmailDeliveryEvent } from './delivery-events.ts'
import { applyOutboundEmailAbusePause } from './outbound-abuse.ts'
import { dispatchEmailDeliverySubscriptionEvents } from './package-subscriptions.ts'

const unmatchedRetryDelaySeconds = 30
export const emailDeliveryQueueName = 'kody-email-delivery'

export async function handleEmailDeliveryQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
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
				case 'stale':
					// Out-of-order events still count toward the abuse
					// thresholds when they persisted: the bounce/complaint
					// happened even when a newer status already superseded
					// it. Conflicting duplicates that were not inserted only
					// pause when persisted events back them.
					await applyOutboundEmailAbusePause({
						env,
						userId: result.message.userId,
						deliveryStatus: result.event.payload.delivery.status,
						eventRecorded: false,
					})
					queueMessage.ack()
					break
				case 'duplicate':
				case 'recorded': {
					// Abuse evaluation runs before subscription dispatch (and
					// also for replayed duplicates) so a crash or dispatch
					// failure can never skip the pause; the pause write itself
					// is idempotent.
					await applyOutboundEmailAbusePause({
						env,
						userId: result.message.userId,
						deliveryStatus: result.event.payload.delivery.status,
						eventRecorded: result.outcome === 'recorded',
					})
					await dispatchEmailDeliverySubscriptionEvents({
						env,
						message: result.message,
						providerEvent: result.event,
					})
					queueMessage.ack()
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
