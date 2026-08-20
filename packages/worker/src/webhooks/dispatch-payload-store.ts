import {
	type WebhookDispatchQueueMessage,
	webhookDispatchPayloadKvKey,
	webhookDispatchPayloadTtlSeconds,
} from './dispatch-queue-producer.ts'
import { parseWebhookJsonBody } from './params.ts'

export {
	webhookDispatchPayloadKvKey,
	webhookDispatchPayloadKvPrefix,
	webhookDispatchPayloadTtlSeconds,
} from './dispatch-queue-producer.ts'

export async function storeWebhookDispatchPayload(input: {
	kv: Pick<KVNamespace, 'put'>
	userId: string
	deliveryId: string
	body: string
}) {
	const key = webhookDispatchPayloadKvKey(input.userId, input.deliveryId)
	await input.kv.put(key, input.body, {
		expirationTtl: webhookDispatchPayloadTtlSeconds,
	})
	return key
}

export async function loadWebhookDispatchPayload(input: {
	kv: Pick<KVNamespace, 'get'>
	key: string
	expectedUserId: string
	expectedDeliveryId: string
}) {
	const expected = webhookDispatchPayloadKvKey(
		input.expectedUserId,
		input.expectedDeliveryId,
	)
	if (input.key !== expected) return null
	return await input.kv.get(input.key)
}

export async function deleteWebhookDispatchPayload(input: {
	kv: Pick<KVNamespace, 'delete'>
	key: string
}) {
	await input.kv.delete(input.key)
}

export async function hydrateWebhookDispatchQueueMessage(input: {
	message: WebhookDispatchQueueMessage
	kv: Pick<KVNamespace, 'get'>
}): Promise<WebhookDispatchQueueMessage | null> {
	let body = input.message.params.request.body
	if (input.message.payloadKvKey) {
		const stored = await loadWebhookDispatchPayload({
			kv: input.kv,
			key: input.message.payloadKvKey,
			expectedUserId: input.message.endpoint.userId,
			expectedDeliveryId: input.message.deliveryId,
		})
		if (stored == null) return null
		body = stored
	}
	return {
		...input.message,
		params: {
			...input.message.params,
			request: {
				...input.message.params.request,
				body,
				json: parseWebhookJsonBody(body),
			},
		},
	}
}
