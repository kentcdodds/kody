import { expect, test } from 'vitest'
import {
	createWebhookDispatchQueueMessage,
	getWebhookDispatchQueueMessageBytes,
	parseWebhookDispatchQueueMessage,
	webhookDispatchPayloadKvKey,
	webhookDispatchQueueMessageMaxBytes,
	withSpilledWebhookDispatchPayload,
} from './dispatch-queue-producer.ts'
import {
	deleteWebhookDispatchPayload,
	hydrateWebhookDispatchQueueMessage,
	storeWebhookDispatchPayload,
	webhookDispatchPayloadTtlSeconds,
} from './dispatch-payload-store.ts'

function createKv(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial))
	const puts: Array<{ key: string; value: string; expirationTtl?: number }> = []
	return {
		values,
		puts,
		async get(key: string) {
			return values.get(key) ?? null
		},
		async put(
			key: string,
			value: string,
			options?: { expirationTtl?: number },
		) {
			values.set(key, value)
			puts.push({ key, value, expirationTtl: options?.expirationTtl })
		},
		async delete(key: string) {
			values.delete(key)
		},
	}
}

function createParams(body: string) {
	return {
		webhook: {
			packageKodyId: 'sentry-triage',
			name: 'sentry',
			receivedAt: '2026-08-19T21:54:10.904Z',
		},
		request: {
			method: 'POST',
			contentType: 'application/json',
			headers: { 'sentry-hook-resource': 'issue' },
			body,
			json: { ignored: true },
		},
	}
}

function createInput(body: string) {
	return {
		endpoint: {
			id: 'endpoint-1',
			userId: 'user-1',
			packageId: 'package-1',
			webhookName: 'sentry',
		},
		packageKodyId: 'sentry-triage',
		exportName: './process-sentry-webhook',
		params: createParams(body),
		idempotencyKey: 'webhook:endpoint-1:delivery-1',
		deliveryId: 'delivery-1',
		payloadBytes: body.length,
		receivedAt: '2026-08-19T21:54:10.904Z',
	}
}

test('ack queue messages drop reconstructed json and spill bodies that miss the 120 KB ceiling', async () => {
	const compact = createWebhookDispatchQueueMessage(
		createInput(JSON.stringify({ event: 'error' })),
	)
	expect(compact.params.request.json).toBeNull()
	expect(parseWebhookDispatchQueueMessage(compact)).toEqual(compact)
	expect(getWebhookDispatchQueueMessageBytes(compact)).toBeLessThan(
		webhookDispatchQueueMessageMaxBytes,
	)

	const midSizeBody = JSON.stringify({ payload: 'x'.repeat(70_000) })
	const midSize = createWebhookDispatchQueueMessage(createInput(midSizeBody))
	expect(midSize.params.request.json).toBeNull()
	expect(getWebhookDispatchQueueMessageBytes(midSize)).toBeLessThan(
		webhookDispatchQueueMessageMaxBytes,
	)

	const largeBody = JSON.stringify({ payload: 'y'.repeat(143_315) })
	const large = createWebhookDispatchQueueMessage(createInput(largeBody))
	expect(getWebhookDispatchQueueMessageBytes(large)).toBeGreaterThan(
		webhookDispatchQueueMessageMaxBytes,
	)

	const kv = createKv()
	const payloadKvKey = await storeWebhookDispatchPayload({
		kv,
		userId: 'user-1',
		deliveryId: 'delivery-1',
		body: largeBody,
	})
	expect(payloadKvKey).toBe(webhookDispatchPayloadKvKey('user-1', 'delivery-1'))
	expect(kv.puts[0]?.expirationTtl).toBe(webhookDispatchPayloadTtlSeconds)

	const spilled = withSpilledWebhookDispatchPayload(large, payloadKvKey)
	expect(spilled.params.request.body).toBe('')
	expect(spilled.payloadKvKey).toBe(payloadKvKey)
	expect(getWebhookDispatchQueueMessageBytes(spilled)).toBeLessThan(
		webhookDispatchQueueMessageMaxBytes,
	)
	expect(parseWebhookDispatchQueueMessage(spilled)).toEqual(spilled)
	expect(
		parseWebhookDispatchQueueMessage({
			...spilled,
			payloadKvKey: webhookDispatchPayloadKvKey('user-2', 'delivery-1'),
		}),
	).toBeNull()

	const hydrated = await hydrateWebhookDispatchQueueMessage({
		message: spilled,
		kv,
	})
	expect(hydrated?.params.request.body).toBe(largeBody)
	expect(hydrated?.params.request.json).toEqual({
		payload: 'y'.repeat(143_315),
	})

	await deleteWebhookDispatchPayload({ kv, key: payloadKvKey })
	await expect(
		hydrateWebhookDispatchQueueMessage({
			message: spilled,
			kv,
		}),
	).resolves.toBeNull()
})
