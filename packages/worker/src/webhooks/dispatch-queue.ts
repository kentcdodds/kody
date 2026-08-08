import {
	dispatchWebhookInvocation,
	readWebhookInvocationResult,
	recordWebhookDelivery,
} from './delivery.ts'
import { webhookDispatchQueueName } from './dispatch-queue-names.ts'
import {
	parseWebhookDispatchQueueMessage,
	type WebhookDispatchQueueMessage,
} from './dispatch-queue-producer.ts'

const webhookDispatchRetryDelaySeconds = 30
const retryableInvocationErrorCodes = new Set([
	'idempotency_lookup_failed',
	'idempotency_persistence_failed',
	'invocation_in_progress',
])

function readInvocationErrorCode(body: unknown): string | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) return null
	const code = (error as Record<string, unknown>)['code']
	return typeof code === 'string' ? code : null
}

export async function processWebhookDispatch(
	message: WebhookDispatchQueueMessage,
	env: Env,
): Promise<'terminal' | 'retry'> {
	const response = await dispatchWebhookInvocation({
		env,
		endpoint: message.endpoint,
		packageKodyId: message.packageKodyId,
		exportName: message.exportName,
		params: message.params,
		idempotencyKey: message.idempotencyKey,
	})
	const errorCode = readInvocationErrorCode(response.body)
	if (errorCode && retryableInvocationErrorCodes.has(errorCode)) return 'retry'

	const ok = response.status >= 200 && response.status < 300
	await recordWebhookDelivery({
		env,
		endpoint: message.endpoint,
		kodyId: message.packageKodyId,
		outcome: ok ? 'delivered' : 'failed',
		httpStatus: ok ? 202 : 502,
		error: ok ? null : `invocation_status_${response.status}`,
		payloadBytes: message.payloadBytes,
		invocationId: message.deliveryId,
		result: readWebhookInvocationResult(response.body),
		startedAt: message.receivedAt,
		requirePersistence: true,
	})
	return 'terminal'
}

export async function handleWebhookDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
) {
	for (const queueMessage of batch.messages) {
		const message = parseWebhookDispatchQueueMessage(queueMessage.body)
		if (!message) {
			console.error('webhook-dispatch-message-invalid', {
				queueMessageId: queueMessage.id,
			})
			queueMessage.ack()
			continue
		}
		try {
			const outcome = await processWebhookDispatch(message, env)
			if (outcome === 'retry') {
				queueMessage.retry({ delaySeconds: webhookDispatchRetryDelaySeconds })
			} else {
				queueMessage.ack()
			}
		} catch (error) {
			console.error('webhook-dispatch-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				endpointId: message.endpoint.id,
				error,
			})
			queueMessage.retry({ delaySeconds: webhookDispatchRetryDelaySeconds })
		}
	}
}

export { webhookDispatchQueueName }
