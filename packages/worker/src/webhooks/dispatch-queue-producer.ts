import { type WebhookExportParams } from './types.ts'

// Cloudflare Queues caps a message (body + metadata) at 128,000 bytes. Keep
// enough headroom for transport metadata and structured-clone framing.
export const webhookDispatchQueueMessageMaxBytes = 120_000

export type WebhookDispatchQueueMessage = {
	endpoint: {
		id: string
		userId: string
		packageId: string
		webhookName: string
	}
	packageKodyId: string
	exportName: string
	params: WebhookExportParams
	idempotencyKey: string
	deliveryId: string
	payloadBytes: number
	receivedAt: string
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

export function parseWebhookDispatchQueueMessage(
	body: unknown,
): WebhookDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const message = body as Record<string, unknown>
	const endpoint = message['endpoint']
	const params = message['params']
	if (
		!endpoint ||
		typeof endpoint !== 'object' ||
		Array.isArray(endpoint) ||
		!params ||
		typeof params !== 'object' ||
		Array.isArray(params)
	) {
		return null
	}
	const endpointRecord = endpoint as Record<string, unknown>
	const id = endpointRecord['id']
	const userId = endpointRecord['userId']
	const packageId = endpointRecord['packageId']
	const webhookName = endpointRecord['webhookName']
	const packageKodyId = message['packageKodyId']
	const exportName = message['exportName']
	const idempotencyKey = message['idempotencyKey']
	const deliveryId = message['deliveryId']
	const payloadBytes = message['payloadBytes']
	const receivedAt = message['receivedAt']
	if (
		!isNonEmptyString(id) ||
		!isNonEmptyString(userId) ||
		!isNonEmptyString(packageId) ||
		!isNonEmptyString(webhookName) ||
		!isNonEmptyString(packageKodyId) ||
		!isNonEmptyString(exportName) ||
		!isNonEmptyString(idempotencyKey) ||
		!isNonEmptyString(deliveryId) ||
		typeof payloadBytes !== 'number' ||
		!Number.isInteger(payloadBytes) ||
		payloadBytes < 0 ||
		!isNonEmptyString(receivedAt)
	) {
		return null
	}
	return {
		endpoint: {
			id,
			userId,
			packageId,
			webhookName,
		},
		packageKodyId,
		exportName,
		params: params as WebhookExportParams,
		idempotencyKey,
		deliveryId,
		payloadBytes,
		receivedAt,
	}
}

export function getWebhookDispatchQueueMessageBytes(
	message: WebhookDispatchQueueMessage,
) {
	return new TextEncoder().encode(JSON.stringify(message)).byteLength
}

export async function enqueueWebhookDispatch(input: {
	queue: Pick<Queue<WebhookDispatchQueueMessage>, 'send'>
	message: WebhookDispatchQueueMessage
}) {
	await input.queue.send(input.message)
}
