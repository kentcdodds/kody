import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { systemEmailOwnerId } from './email-owner.ts'

const mocks = vi.hoisted(() => ({
	processInboundDeliveryEffects: vi.fn(),
}))

vi.mock('./inbound-effects.ts', () => ({
	processInboundDeliveryEffects: mocks.processInboundDeliveryEffects,
}))

const {
	scheduleInboundReceivedTerminalWork,
	scheduleInboundRejectedTerminalWork,
} = await import('./inbound-mailbox.ts')

function createCapturedWaitUntilContext() {
	const waitUntilPromises: Array<Promise<unknown>> = []
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise)
		},
		passThroughOnException() {},
	} as ExecutionContext
	return { ctx, waitUntilPromises }
}

test('received USER terminal work dispatches Mailbox-authoritative effects through waitUntil', async () => {
	mocks.processInboundDeliveryEffects.mockResolvedValueOnce({
		outcome: 'complete',
	})
	const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
	const env = {} as Parameters<
		typeof scheduleInboundReceivedTerminalWork
	>[0]['env']

	await scheduleInboundReceivedTerminalWork({
		env,
		userId: 'user-1',
		messageId: 'message-1',
		deliveryId: 'delivery-1',
		expectedFinalizationToken: 'token-1',
		durationMs: 12,
		ctx,
		logLabel: 'Inbound email effect dispatch failed',
	})
	await Promise.all(waitUntilPromises)

	expect(waitUntilPromises).toHaveLength(1)
	expect(mocks.processInboundDeliveryEffects).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		deliveryId: 'delivery-1',
		expectedFinalizationToken: 'token-1',
		durationMs: 12,
		waitUntil: expect.any(Function),
	})
})

test('received terminal work contains effect failures and rejected terminal work is already durable', async () => {
	consoleError.mockImplementation(() => {})
	mocks.processInboundDeliveryEffects.mockRejectedValueOnce(
		new Error('effects exploded'),
	)
	const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
	const env = {} as Parameters<
		typeof scheduleInboundReceivedTerminalWork
	>[0]['env']

	await scheduleInboundReceivedTerminalWork({
		env,
		userId: 'user-2',
		messageId: 'message-2',
		deliveryId: 'delivery-2',
		ctx,
		logLabel: 'Inbound email effect dispatch failed',
	})
	await scheduleInboundRejectedTerminalWork({
		env,
		userId: 'user-2',
		deliveryId: 'delivery-3',
		ctx,
	})
	await expect(Promise.all(waitUntilPromises)).resolves.toEqual([
		undefined,
		undefined,
	])

	expect(consoleError).toHaveBeenCalledWith(
		'Inbound email effect dispatch failed',
		expect.any(Error),
	)
	expect(mocks.processInboundDeliveryEffects).toHaveBeenCalledTimes(1)
})

test('received and rejected coordinators skip system:email', async () => {
	const env = {} as Parameters<
		typeof scheduleInboundReceivedTerminalWork
	>[0]['env']
	await scheduleInboundReceivedTerminalWork({
		env,
		userId: systemEmailOwnerId,
		messageId: 'message-system',
		deliveryId: 'delivery-system',
		logLabel: 'System should not run',
	})
	await scheduleInboundRejectedTerminalWork({
		env,
		userId: systemEmailOwnerId,
		deliveryId: 'delivery-system',
	})

	expect(mocks.processInboundDeliveryEffects).not.toHaveBeenCalled()
})
