import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	processCloudflareEmailDeliveryEvent: vi.fn(),
	dispatchEmailDeliverySubscriptionEvents: vi.fn(async () => []),
	mirrorMailboxMessageGraphFromD1: vi.fn(async () => ({
		messageId: 'message-1',
		message: { status: 'mirrored' as const },
		events: [],
	})),
}))

vi.mock('./delivery-events.ts', () => ({
	processCloudflareEmailDeliveryEvent:
		mocks.processCloudflareEmailDeliveryEvent,
}))

vi.mock('./mailbox-live-mirror.ts', () => ({
	mirrorMailboxMessageGraphFromD1: mocks.mirrorMailboxMessageGraphFromD1,
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchEmailDeliverySubscriptionEvents:
		mocks.dispatchEmailDeliverySubscriptionEvents,
}))

const { handleEmailDeliveryQueue } = await import('./delivery-queue.ts')

function createQueueMessage(id: string, body: unknown) {
	return {
		id,
		timestamp: new Date('2026-07-17T20:00:00.000Z'),
		body,
		attempts: 1,
		ack: vi.fn(),
		retry: vi.fn(),
	}
}

test('email delivery Queue acknowledges permanent outcomes and retries unmatched messages', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const recorded = createQueueMessage('queue-recorded', { kind: 'recorded' })
	const duplicate = createQueueMessage('queue-duplicate', { kind: 'duplicate' })
	const invalid = createQueueMessage('queue-invalid', { kind: 'invalid' })
	const stale = createQueueMessage('queue-stale', { kind: 'stale' })
	const unmatched = createQueueMessage('queue-unmatched', { kind: 'unmatched' })
	const dispatchFailure = createQueueMessage('queue-dispatch-failure', {
		kind: 'dispatch-failure',
	})
	// A `delivered` status keeps the outbound abuse monitor on its no-op
	// path, so this test stays focused on queue mechanics.
	const providerEvent = {
		payload: {
			eventId: 'event-1',
			messageId: 'provider-1',
			delivery: { status: 'delivered' },
		},
	}
	const storedMessage = { id: 'message-1', userId: 'user-1' }
	const d1Event = {
		id: 'd1-event-1',
		messageId: 'message-1',
		userId: 'user-1',
		inboxId: 'inbox-1',
		eventType: 'delivered',
		provider: 'cloudflare-email',
		providerMessageId: 'provider-1',
		providerEventId: 'event-1',
		detailJson: '{}',
		createdAt: '2026-07-17T20:02:00.000Z',
	}
	mocks.processCloudflareEmailDeliveryEvent
		.mockResolvedValueOnce({
			outcome: 'recorded',
			providerEvent,
			event: d1Event,
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'duplicate',
			providerEvent,
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'invalid',
			providerEvent: null,
			event: null,
			message: null,
		})
		.mockResolvedValueOnce({
			outcome: 'stale',
			providerEvent,
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'unmatched',
			providerEvent,
			message: null,
		})
		.mockResolvedValueOnce({
			outcome: 'recorded',
			providerEvent,
			event: d1Event,
			message: storedMessage,
		})
	mocks.dispatchEmailDeliverySubscriptionEvents
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(
			new Error('artifact_preparation_failed: transient KV failure'),
		)
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext

	await handleEmailDeliveryQueue(
		{
			queue: 'kody-email-delivery',
			messages: [
				recorded,
				duplicate,
				invalid,
				stale,
				unmatched,
				dispatchFailure,
			],
			ackAll() {},
			retryAll() {},
		} as unknown as MessageBatch<unknown>,
		{ APP_DB: {} } as Env,
		ctx,
	)
	await Promise.all(waitUntilPromises)

	expect(recorded.ack).toHaveBeenCalledTimes(1)
	expect(duplicate.ack).toHaveBeenCalledTimes(1)
	expect(invalid.ack).toHaveBeenCalledTimes(1)
	expect(stale.ack).toHaveBeenCalledTimes(1)
	expect(unmatched.ack).not.toHaveBeenCalled()
	expect(unmatched.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(dispatchFailure.ack).not.toHaveBeenCalled()
	expect(dispatchFailure.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(mocks.dispatchEmailDeliverySubscriptionEvents).toHaveBeenCalledTimes(3)
	expect(mocks.dispatchEmailDeliverySubscriptionEvents).toHaveBeenNthCalledWith(
		1,
		{
			env: expect.anything(),
			message: storedMessage,
			providerEvent,
			waitUntil: expect.any(Function),
		},
	)
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledTimes(3)
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenNthCalledWith(1, {
		env: expect.anything(),
		db: expect.anything(),
		userId: 'user-1',
		messageId: 'message-1',
	})
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenNthCalledWith(2, {
		env: expect.anything(),
		db: expect.anything(),
		userId: 'user-1',
		messageId: 'message-1',
	})
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenNthCalledWith(3, {
		env: expect.anything(),
		db: expect.anything(),
		userId: 'user-1',
		messageId: 'message-1',
	})
	expect(waitUntilPromises).toHaveLength(3)
	expect(consoleWarn).toHaveBeenCalledWith('email-delivery-event-unmatched', {
		queueMessageId: 'queue-unmatched',
		providerMessageId: 'provider-1',
	})
	expect(consoleError).toHaveBeenCalledWith(
		'email-delivery-event-processing-failed',
		expect.objectContaining({ message: expect.stringContaining('KV failure') }),
	)
})

test('recorded delivery events schedule mailbox graph mirror via waitUntil without blocking ack', async () => {
	consoleError.mockImplementation(() => {})
	mocks.processCloudflareEmailDeliveryEvent.mockReset()
	mocks.mirrorMailboxMessageGraphFromD1.mockReset()
	mocks.dispatchEmailDeliverySubscriptionEvents.mockReset()
	mocks.dispatchEmailDeliverySubscriptionEvents.mockResolvedValue([])

	const providerEvent = {
		payload: {
			eventId: 'event-mirror',
			messageId: 'provider-mirror',
			delivery: { status: 'delivered' },
		},
	}
	const storedMessage = { id: 'message-mirror', userId: 'user-mirror' }
	mocks.processCloudflareEmailDeliveryEvent.mockResolvedValue({
		outcome: 'recorded',
		providerEvent,
		event: { id: 'd1-event-mirror' },
		message: storedMessage,
	})

	let resolveMirror: (() => void) | undefined
	const mirrorPromise = new Promise<{ messageId: string }>((resolve) => {
		resolveMirror = () =>
			resolve({
				messageId: 'message-mirror',
				message: { status: 'mirrored' },
				events: [],
			})
	})
	mocks.mirrorMailboxMessageGraphFromD1.mockReturnValue(mirrorPromise)

	const queueMessage = createQueueMessage('queue-mirror', { kind: 'recorded' })
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext

	await handleEmailDeliveryQueue(
		{
			queue: 'kody-email-delivery',
			messages: [queueMessage],
			ackAll() {},
			retryAll() {},
		} as unknown as MessageBatch<unknown>,
		{ APP_DB: {} } as Env,
		ctx,
	)

	expect(queueMessage.ack).toHaveBeenCalledTimes(1)
	expect(queueMessage.retry).not.toHaveBeenCalled()
	expect(waitUntilPromises).toHaveLength(1)
	resolveMirror?.()
	await Promise.all(waitUntilPromises)
})

test('mailbox graph mirror failures scheduled in waitUntil do not reject or alter queue ack', async () => {
	consoleError.mockImplementation(() => {})
	mocks.processCloudflareEmailDeliveryEvent.mockReset()
	mocks.mirrorMailboxMessageGraphFromD1.mockReset()
	mocks.dispatchEmailDeliverySubscriptionEvents.mockReset()
	mocks.dispatchEmailDeliverySubscriptionEvents.mockResolvedValue([])

	const providerEvent = {
		payload: {
			eventId: 'event-fail',
			messageId: 'provider-fail',
			delivery: { status: 'delivered' },
		},
	}
	const storedMessage = { id: 'message-fail', userId: 'user-fail' }
	mocks.processCloudflareEmailDeliveryEvent.mockResolvedValue({
		outcome: 'recorded',
		providerEvent,
		event: { id: 'd1-event-fail' },
		message: storedMessage,
	})
	mocks.mirrorMailboxMessageGraphFromD1.mockRejectedValue(
		new Error('mailbox rpc unavailable'),
	)

	const queueMessage = createQueueMessage('queue-mirror-fail', {
		kind: 'recorded',
	})
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext

	await handleEmailDeliveryQueue(
		{
			queue: 'kody-email-delivery',
			messages: [queueMessage],
			ackAll() {},
			retryAll() {},
		} as unknown as MessageBatch<unknown>,
		{ APP_DB: {} } as Env,
		ctx,
	)

	expect(queueMessage.ack).toHaveBeenCalledTimes(1)
	expect(queueMessage.retry).not.toHaveBeenCalled()
	await expect(Promise.all(waitUntilPromises)).rejects.toThrow(
		'mailbox rpc unavailable',
	)
})

test('stale inserted provider events schedule mailbox graph mirror without subscription dispatch', async () => {
	consoleError.mockImplementation(() => {})
	mocks.processCloudflareEmailDeliveryEvent.mockReset()
	mocks.mirrorMailboxMessageGraphFromD1.mockReset()
	mocks.dispatchEmailDeliverySubscriptionEvents.mockReset()

	const providerEvent = {
		payload: {
			eventId: 'event-stale-insert',
			messageId: 'provider-stale',
			delivery: { status: 'deferred' },
		},
	}
	const storedMessage = { id: 'message-stale', userId: 'user-stale' }
	mocks.processCloudflareEmailDeliveryEvent.mockResolvedValue({
		outcome: 'stale',
		providerEvent,
		message: storedMessage,
	})

	const queueMessage = createQueueMessage('queue-stale-insert', {
		kind: 'stale',
	})
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext

	await handleEmailDeliveryQueue(
		{
			queue: 'kody-email-delivery',
			messages: [queueMessage],
			ackAll() {},
			retryAll() {},
		} as unknown as MessageBatch<unknown>,
		{ APP_DB: {} } as Env,
		ctx,
	)
	await Promise.all(waitUntilPromises)

	expect(queueMessage.ack).toHaveBeenCalledTimes(1)
	expect(queueMessage.retry).not.toHaveBeenCalled()
	expect(mocks.dispatchEmailDeliverySubscriptionEvents).not.toHaveBeenCalled()
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledTimes(1)
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledWith({
		env: expect.anything(),
		db: expect.anything(),
		userId: 'user-stale',
		messageId: 'message-stale',
	})
	expect(waitUntilPromises).toHaveLength(1)
})

test('duplicate retry after recorded dispatch failure schedules mailbox graph mirror', async () => {
	consoleError.mockImplementation(() => {})
	mocks.processCloudflareEmailDeliveryEvent.mockReset()
	mocks.mirrorMailboxMessageGraphFromD1.mockReset()
	mocks.dispatchEmailDeliverySubscriptionEvents.mockReset()

	const providerEvent = {
		payload: {
			eventId: 'event-retry',
			messageId: 'provider-retry',
			delivery: { status: 'delivered' },
		},
	}
	const storedMessage = { id: 'message-retry', userId: 'user-retry' }
	mocks.processCloudflareEmailDeliveryEvent
		.mockResolvedValueOnce({
			outcome: 'recorded',
			providerEvent,
			event: { id: 'd1-event-retry' },
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'duplicate',
			providerEvent,
			message: storedMessage,
		})
	mocks.dispatchEmailDeliverySubscriptionEvents
		.mockRejectedValueOnce(
			new Error('artifact_preparation_failed: transient KV failure'),
		)
		.mockResolvedValueOnce([])

	const queueMessage = createQueueMessage('queue-retry', { kind: 'recorded' })
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			void promise
		},
		passThroughOnException() {},
	} as ExecutionContext
	const batch = {
		queue: 'kody-email-delivery',
		messages: [queueMessage],
		ackAll() {},
		retryAll() {},
	} as unknown as MessageBatch<unknown>

	await handleEmailDeliveryQueue(batch, { APP_DB: {} } as Env, ctx)
	expect(queueMessage.ack).not.toHaveBeenCalled()
	expect(queueMessage.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(mocks.mirrorMailboxMessageGraphFromD1).not.toHaveBeenCalled()

	const waitUntilPromises: Array<Promise<unknown>> = []
	const retryCtx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext

	await handleEmailDeliveryQueue(batch, { APP_DB: {} } as Env, retryCtx)
	await Promise.all(waitUntilPromises)

	expect(queueMessage.ack).toHaveBeenCalledTimes(1)
	expect(queueMessage.retry).toHaveBeenCalledTimes(1)
	expect(mocks.dispatchEmailDeliverySubscriptionEvents).toHaveBeenCalledTimes(2)
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledTimes(1)
	expect(mocks.mirrorMailboxMessageGraphFromD1).toHaveBeenCalledWith({
		env: expect.anything(),
		db: expect.anything(),
		userId: 'user-retry',
		messageId: 'message-retry',
	})
	expect(waitUntilPromises).toHaveLength(1)
	expect(consoleError).toHaveBeenCalledWith(
		'email-delivery-event-processing-failed',
		expect.objectContaining({ message: expect.stringContaining('KV failure') }),
	)
})
