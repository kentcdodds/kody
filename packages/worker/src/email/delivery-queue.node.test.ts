import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	processCloudflareEmailDeliveryEvent: vi.fn(),
	applyOutboundEmailAbusePause: vi.fn(),
	dispatchEmailDeliverySubscriptionEvents: vi.fn(),
}))

vi.mock('./delivery-events.ts', () => ({
	processCloudflareEmailDeliveryEvent:
		mocks.processCloudflareEmailDeliveryEvent,
}))

vi.mock('./outbound-abuse.ts', () => ({
	applyOutboundEmailAbusePause: mocks.applyOutboundEmailAbusePause,
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

test('delivery queue handles terminal outcomes without a D1-to-Mailbox graph mirror', async () => {
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
	const providerEvent = {
		payload: {
			eventId: 'event-1',
			messageId: 'provider-1',
			delivery: { status: 'delivered' },
		},
	}
	const storedMessage = { id: 'message-1', userId: 'user-1' }
	mocks.processCloudflareEmailDeliveryEvent
		.mockResolvedValueOnce({
			outcome: 'recorded',
			providerEvent,
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
			message: storedMessage,
		})
	mocks.applyOutboundEmailAbusePause.mockResolvedValue(undefined)
	mocks.dispatchEmailDeliverySubscriptionEvents
		.mockResolvedValueOnce([])
		.mockResolvedValueOnce([])
		.mockRejectedValueOnce(new Error('transient subscription failure'))
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	const prepare = vi.fn()

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
		{ APP_DB: { prepare } } as unknown as Env,
		ctx,
	)

	expect(recorded.ack).toHaveBeenCalledOnce()
	expect(duplicate.ack).toHaveBeenCalledOnce()
	expect(invalid.ack).toHaveBeenCalledOnce()
	expect(stale.ack).toHaveBeenCalledOnce()
	expect(unmatched.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(dispatchFailure.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(mocks.dispatchEmailDeliverySubscriptionEvents).toHaveBeenCalledTimes(3)
	expect(waitUntilPromises).toHaveLength(0)
	expect(prepare).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith('email-delivery-event-unmatched', {
		queueMessageId: 'queue-unmatched',
		providerMessageId: 'provider-1',
	})
	expect(consoleError).toHaveBeenCalledWith(
		'email-delivery-event-processing-failed',
		expect.any(Error),
	)
})
