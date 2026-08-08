import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	handleWebhookDispatchQueue,
	processWebhookDispatch,
} from './dispatch-queue.ts'
import {
	getWebhookDispatchQueueMessageBytes,
	parseWebhookDispatchQueueMessage,
	webhookDispatchQueueMessageMaxBytes,
	type WebhookDispatchQueueMessage,
} from './dispatch-queue-producer.ts'

const mocks = vi.hoisted(() => ({
	dispatchWebhookInvocation: vi.fn(),
	recordWebhookDelivery: vi.fn(),
}))

vi.mock('./delivery.ts', () => ({
	dispatchWebhookInvocation: (...args: Array<unknown>) =>
		mocks.dispatchWebhookInvocation(...args),
	readWebhookInvocationResult: (body: unknown) =>
		body && typeof body === 'object'
			? (body as Record<string, unknown>)['result']
			: undefined,
	recordWebhookDelivery: (...args: Array<unknown>) =>
		mocks.recordWebhookDelivery(...args),
}))

function createMessage(): WebhookDispatchQueueMessage {
	return {
		endpoint: {
			id: 'endpoint-1',
			userId: 'user-1',
			packageId: 'package-1',
			webhookName: 'sentry',
		},
		packageKodyId: 'sentry-triage',
		exportName: './handle-sentry-webhook',
		params: {
			webhook: {
				packageKodyId: 'sentry-triage',
				name: 'sentry',
				receivedAt: '2026-08-08T12:00:00.000Z',
			},
			request: {
				method: 'POST',
				contentType: 'application/json',
				headers: {},
				body: '{"event":"error"}',
				json: { event: 'error' },
			},
		},
		idempotencyKey: 'webhook:endpoint-1:delivery-1',
		deliveryId: 'delivery-1',
		payloadBytes: 17,
		receivedAt: '2026-08-08T12:00:00.000Z',
	}
}

function createQueueMessage(id: string, body: unknown) {
	return {
		id,
		timestamp: new Date('2026-08-08T12:00:00.000Z'),
		body,
		attempts: 1,
		ack: vi.fn<() => void>(),
		retry: vi.fn<(options?: { delaySeconds?: number }) => void>(),
	}
}

function createBatch(messages: Array<ReturnType<typeof createQueueMessage>>) {
	return {
		queue: 'kody-webhook-dispatch',
		messages,
		ackAll: vi.fn<() => void>(),
		retryAll: vi.fn<() => void>(),
	} as unknown as MessageBatch<unknown>
}

test('ack webhook work outlives the old waitUntil window and persists a terminal result', async () => {
	vi.useFakeTimers()
	mocks.dispatchWebhookInvocation.mockReset()
	mocks.recordWebhookDelivery.mockReset()
	mocks.dispatchWebhookInvocation.mockImplementation(
		() =>
			new Promise((resolve) => {
				setTimeout(
					() =>
						resolve({
							status: 200,
							body: { ok: true, result: { handled: true } },
						}),
					31_000,
				)
			}),
	)
	mocks.recordWebhookDelivery.mockResolvedValue(undefined)

	const processing = processWebhookDispatch(createMessage(), {} as Env)
	await vi.advanceTimersByTimeAsync(30_000)
	expect(mocks.recordWebhookDelivery).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1_000)
	await expect(processing).resolves.toBe('terminal')
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			outcome: 'delivered',
			httpStatus: 202,
			invocationId: 'delivery-1',
			result: { handled: true },
		}),
	)
	vi.useRealTimers()
})

test('queue retries incomplete terminal persistence and acks terminal outcomes', async () => {
	consoleError.mockImplementation(() => {})
	mocks.dispatchWebhookInvocation.mockReset()
	mocks.recordWebhookDelivery.mockReset()
	mocks.recordWebhookDelivery.mockResolvedValue(undefined)
	mocks.dispatchWebhookInvocation
		.mockResolvedValueOnce({
			status: 500,
			body: {
				ok: false,
				error: { code: 'idempotency_persistence_failed' },
			},
		})
		.mockResolvedValueOnce({
			status: 200,
			body: { ok: true, result: { handled: true } },
		})
		.mockResolvedValueOnce({
			status: 200,
			body: { ok: true, result: { handled: true } },
		})
	mocks.recordWebhookDelivery
		.mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(new Error('RunLog unavailable'))
	const retry = createQueueMessage('retry', createMessage())
	const terminal = createQueueMessage('terminal', createMessage())
	const persistenceFailure = createQueueMessage(
		'persistence-failure',
		createMessage(),
	)
	const invalid = createQueueMessage('invalid', { endpoint: null })

	await handleWebhookDispatchQueue(
		createBatch([retry, terminal, persistenceFailure, invalid]),
		{} as Env,
	)

	expect(retry.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(retry.ack).not.toHaveBeenCalled()
	expect(terminal.ack).toHaveBeenCalledTimes(1)
	expect(terminal.retry).not.toHaveBeenCalled()
	expect(persistenceFailure.ack).not.toHaveBeenCalled()
	expect(persistenceFailure.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(invalid.ack).toHaveBeenCalledTimes(1)
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledTimes(2)
})

test('webhook queue parser rejects malformed isolation and delivery fields', () => {
	const message = createMessage()
	expect(parseWebhookDispatchQueueMessage(message)).toEqual(message)
	expect(
		parseWebhookDispatchQueueMessage({
			...message,
			endpoint: { ...message.endpoint, userId: '' },
		}),
	).toBeNull()
	expect(
		parseWebhookDispatchQueueMessage({ ...message, payloadBytes: -1 }),
	).toBeNull()
	expect(
		parseWebhookDispatchQueueMessage({ ...message, params: [] }),
	).toBeNull()
	expect(getWebhookDispatchQueueMessageBytes(message)).toBeLessThan(
		webhookDispatchQueueMessageMaxBytes,
	)
})
