import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	handleWebhookDispatchQueue,
	processWebhookDispatch,
} from './dispatch-queue.ts'
import {
	createWebhookDispatchQueueMessage,
	getWebhookDispatchQueueMessageBytes,
	parseWebhookDispatchQueueMessage,
	webhookDispatchPayloadKvKey,
	webhookDispatchQueueMessageMaxBytes,
	type WebhookDispatchQueueMessage,
} from './dispatch-queue-producer.ts'
import { parseWebhookJsonBody } from './params.ts'

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

function hydrateParsedDispatchMessage(
	message: WebhookDispatchQueueMessage,
): WebhookDispatchQueueMessage {
	return {
		...message,
		params: {
			...message.params,
			request: {
				...message.params.request,
				json: parseWebhookJsonBody(message.params.request.body),
			},
		},
	}
}

function queuedDispatchMessage(
	input: Parameters<typeof createWebhookDispatchQueueMessage>[0],
): WebhookDispatchQueueMessage {
	const parsed = parseWebhookDispatchQueueMessage(
		createWebhookDispatchQueueMessage(input),
	)
	if (!parsed) throw new Error('expected serialized queue message to parse')
	return hydrateParsedDispatchMessage(parsed)
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

const handledResponse = {
	status: 200,
	body: { ok: true, result: { handled: true } },
}

function queueOutcome(message: ReturnType<typeof createQueueMessage>) {
	return {
		acks: message.ack.mock.calls.length,
		retries: message.retry.mock.calls,
	}
}

const acked = { acks: 1, retries: [] }
const retried = { acks: 0, retries: [[{ delaySeconds: 30 }]] }

function withRequestBody(
	body: string,
	extra: Partial<WebhookDispatchQueueMessage> = {},
) {
	const message = createMessage()
	return queuedDispatchMessage({
		...message,
		...extra,
		params: {
			...message.params,
			request: { ...message.params.request, body, json: { ignored: true } },
		},
	})
}

test('ack webhook work outlives the old waitUntil window and persists a terminal result', async () => {
	vi.useFakeTimers()
	mocks.dispatchWebhookInvocation.mockImplementation(
		() =>
			new Promise((resolve) => {
				setTimeout(() => resolve(handledResponse), 31_000)
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
	mocks.dispatchWebhookInvocation
		.mockResolvedValueOnce({
			status: 500,
			body: { ok: false, error: { code: 'idempotency_persistence_failed' } },
		})
		.mockResolvedValue(handledResponse)
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

	expect(
		[retry, terminal, persistenceFailure, invalid].map(queueOutcome),
	).toEqual([retried, acked, retried, acked])
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledTimes(2)
})

test('webhook queue parser rejects malformed isolation and delivery fields', () => {
	const message = createMessage()
	const accepted: Array<WebhookDispatchQueueMessage> = [
		message,
		{ ...message, idempotencyParamsHash: 'ignore' },
		{ ...message, inputMode: 'params' },
		{ ...message, callerIdempotency: true },
	]
	expect(accepted.map(parseWebhookDispatchQueueMessage)).toEqual(accepted)
	const rejected: Array<unknown> = [
		{ ...message, endpoint: { ...message.endpoint, userId: '' } },
		{ ...message, payloadBytes: -1 },
		{ ...message, params: [] },
		{ ...message, idempotencyParamsHash: 'include' },
		{ ...message, inputMode: 'request' },
		{ ...message, callerIdempotency: false },
	]
	expect(rejected.map(parseWebhookDispatchQueueMessage)).toEqual(
		rejected.map(() => null),
	)
	expect(getWebhookDispatchQueueMessageBytes(message)).toBeLessThan(
		webhookDispatchQueueMessageMaxBytes,
	)
})

test('queue dispatch unwraps params-mode first args and hashes request-mode caller keys', async () => {
	mocks.dispatchWebhookInvocation.mockResolvedValue(handledResponse)
	mocks.recordWebhookDelivery.mockResolvedValue(undefined)
	const dispatch = async (message: WebhookDispatchQueueMessage) => {
		await expect(processWebhookDispatch(message, {} as Env)).resolves.toBe(
			'terminal',
		)
		return mocks.dispatchWebhookInvocation.mock.lastCall?.[0]
	}

	expect(
		await dispatch(
			withRequestBody(
				JSON.stringify({
					params: { messageId: 'm-1' },
					idempotencyKey: 'evt-1',
				}),
				{ inputMode: 'params' },
			),
		),
	).toMatchObject({ params: { messageId: 'm-1' } })

	const routed = {
		route: 'linkedin/register-video-upload',
		dryRun: false,
		params: { fileSizeBytes: 12 },
	}
	expect(
		await dispatch(
			withRequestBody(JSON.stringify(routed), { inputMode: 'params' }),
		),
	).toMatchObject({ params: routed })

	const uniqueKeyRequestMode = queuedDispatchMessage(createMessage())
	const uniqueKeyCall = await dispatch(uniqueKeyRequestMode)
	expect(uniqueKeyCall).toMatchObject({ params: uniqueKeyRequestMode.params })
	expect(uniqueKeyCall).not.toHaveProperty('idempotencyHashParams')

	const callerKeyRequestMode = queuedDispatchMessage({
		...createMessage(),
		callerIdempotency: true,
		idempotencyKey: 'caller-evt-1',
	})
	expect(await dispatch(callerKeyRequestMode)).toMatchObject({
		params: callerKeyRequestMode.params,
		idempotencyHashParams: { event: 'error' },
	})

	await dispatch(
		withRequestBody('["not","an","object"]', { inputMode: 'params' }),
	)
	expect(mocks.recordWebhookDelivery).toHaveBeenLastCalledWith(
		expect.objectContaining({
			outcome: 'rejected',
			httpStatus: 400,
			error: 'invalid_params',
		}),
	)
})

test('queue dispatch forwards delivery-id params-hash ignore', async () => {
	mocks.dispatchWebhookInvocation.mockResolvedValue(handledResponse)
	mocks.recordWebhookDelivery.mockResolvedValue(undefined)
	const message = {
		...createMessage(),
		idempotencyParamsHash: 'ignore' as const,
	}

	await expect(processWebhookDispatch(message, {} as Env)).resolves.toBe(
		'terminal',
	)
	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledWith(
		expect.objectContaining({
			idempotencyKey: message.idempotencyKey,
			idempotencyParamsHash: 'ignore',
		}),
	)
})

test('queue hydrates spilled payloads, deletes them after terminal work, and acks a missing spill', async () => {
	consoleError.mockImplementation(() => {})
	mocks.dispatchWebhookInvocation.mockResolvedValue(handledResponse)
	mocks.recordWebhookDelivery
		.mockResolvedValueOnce(undefined)
		.mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(new Error('RunLog unavailable'))

	const payloadKvKey = webhookDispatchPayloadKvKey('user-1', 'delivery-1')
	const values = new Map([[payloadKvKey, '{"event":"error","extra":"spill"}']])
	const kv = {
		get: async (key: string) => values.get(key) ?? null,
		delete: async (key: string) => void values.delete(key),
	}
	const spilled = createMessage()
	spilled.params.request.body = ''
	spilled.params.request.json = null
	spilled.payloadKvKey = payloadKvKey
	const missingSpill = (deliveryId: string) =>
		createQueueMessage(deliveryId, {
			...spilled,
			deliveryId,
			idempotencyKey: `webhook:endpoint-1:${deliveryId}`,
			payloadKvKey: webhookDispatchPayloadKvKey('user-1', deliveryId),
		})
	const queued = createQueueMessage('spilled', spilled)
	const missing = missingSpill('delivery-missing')
	const missingRecordFailure = missingSpill('delivery-missing-record')

	await handleWebhookDispatchQueue(
		createBatch([queued, missing, missingRecordFailure]),
		{ BUNDLE_ARTIFACTS_KV: kv } as unknown as Env,
	)

	expect([queued, missing, missingRecordFailure].map(queueOutcome)).toEqual([
		acked,
		acked,
		retried,
	])
	expect(values.has(payloadKvKey)).toBe(false)
	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledTimes(1)
	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledWith(
		expect.objectContaining({
			params: expect.objectContaining({
				request: expect.objectContaining({
					body: '{"event":"error","extra":"spill"}',
					json: { event: 'error', extra: 'spill' },
				}),
			}),
		}),
	)
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			outcome: 'failed',
			error: 'ack_queue_payload_missing',
			invocationId: 'delivery-missing',
		}),
	)
})
