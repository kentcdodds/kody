import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	processCloudflareEmailDeliveryEvent: vi.fn(),
	dispatchEmailDeliverySubscriptionEvents: vi.fn(async () => []),
}))

vi.mock('./delivery-events.ts', () => ({
	processCloudflareEmailDeliveryEvent:
		mocks.processCloudflareEmailDeliveryEvent,
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
	const recorded = createQueueMessage('queue-recorded', { kind: 'recorded' })
	const duplicate = createQueueMessage('queue-duplicate', { kind: 'duplicate' })
	const invalid = createQueueMessage('queue-invalid', { kind: 'invalid' })
	const unmatched = createQueueMessage('queue-unmatched', { kind: 'unmatched' })
	const providerEvent = {
		payload: { eventId: 'event-1', messageId: 'provider-1' },
	}
	const storedMessage = { id: 'message-1', userId: 'user-1' }
	mocks.processCloudflareEmailDeliveryEvent
		.mockResolvedValueOnce({
			outcome: 'recorded',
			event: providerEvent,
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'duplicate',
			event: providerEvent,
			message: storedMessage,
		})
		.mockResolvedValueOnce({
			outcome: 'invalid',
			event: null,
			message: null,
		})
		.mockResolvedValueOnce({
			outcome: 'unmatched',
			event: providerEvent,
			message: null,
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
			messages: [recorded, duplicate, invalid, unmatched],
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
	expect(unmatched.ack).not.toHaveBeenCalled()
	expect(unmatched.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
	expect(mocks.dispatchEmailDeliverySubscriptionEvents).toHaveBeenCalledWith({
		env: expect.anything(),
		message: storedMessage,
		providerEvent,
	})
	expect(consoleWarn).toHaveBeenCalledWith('email-delivery-event-unmatched', {
		queueMessageId: 'queue-unmatched',
		providerMessageId: 'provider-1',
	})
})
