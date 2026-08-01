import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { systemEmailOwnerId } from './email-owner.ts'

const mocks = vi.hoisted(() => ({
	mirrorMailboxMessageGraphFromD1: vi.fn(async () => ({
		messageId: 'msg-1',
		message: { status: 'mirrored' as const },
		events: [],
		eventsTruncated: false,
	})),
	mirrorMailboxDeliveryEventFromD1: vi.fn(async () => ({
		status: 'mirrored' as const,
	})),
	processInboundDeliveryEffects: vi.fn(async () => ({
		outcome: 'complete' as const,
	})),
}))

vi.mock('./mailbox-live-mirror.ts', () => ({
	mirrorMailboxMessageGraphFromD1: mocks.mirrorMailboxMessageGraphFromD1,
	mirrorMailboxDeliveryEventFromD1: mocks.mirrorMailboxDeliveryEventFromD1,
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

function resetMocks() {
	mocks.mirrorMailboxMessageGraphFromD1.mockReset()
	mocks.mirrorMailboxDeliveryEventFromD1.mockReset()
	mocks.processInboundDeliveryEffects.mockReset()
	mocks.mirrorMailboxMessageGraphFromD1.mockResolvedValue({
		messageId: 'msg-1',
		message: { status: 'mirrored' as const },
		events: [],
		eventsTruncated: false,
	})
	mocks.mirrorMailboxDeliveryEventFromD1.mockResolvedValue({
		status: 'mirrored' as const,
	})
	mocks.processInboundDeliveryEffects.mockResolvedValue({
		outcome: 'complete' as const,
	})
}

test('received terminal work orders graph then effects then event mirror via waitUntil', async () => {
	resetMocks()
	consoleError.mockImplementation(() => {})
	const order: Array<string> = []
	let releaseGraph!: () => void
	const graphGate = new Promise<void>((resolve) => {
		releaseGraph = resolve
	})

	mocks.mirrorMailboxMessageGraphFromD1.mockImplementation(async () => {
		order.push('graph-start')
		await graphGate
		order.push('graph-end')
		return {
			messageId: 'msg-1',
			message: { status: 'mirrored' as const },
			events: [],
			eventsTruncated: false,
		}
	})
	mocks.processInboundDeliveryEffects.mockImplementation(async () => {
		order.push('effects')
		return { outcome: 'complete' as const }
	})
	mocks.mirrorMailboxDeliveryEventFromD1.mockImplementation(async () => {
		order.push('event')
		return { status: 'mirrored' as const }
	})

	const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
	const env = { APP_DB: {} } as unknown as Parameters<
		typeof scheduleInboundReceivedTerminalWork
	>[0]['env']

	await scheduleInboundReceivedTerminalWork({
		env,
		userId: 'user-aaa',
		messageId: 'msg-1',
		deliveryId: 'delivery-1',
		expectedFinalizationToken: 'token-1',
		durationMs: 12,
		ctx,
		logLabel: 'Inbound email effect dispatch failed',
	})

	expect(waitUntilPromises).toHaveLength(1)
	expect(order).toEqual(['graph-start'])
	expect(mocks.processInboundDeliveryEffects).not.toHaveBeenCalled()

	releaseGraph()
	await Promise.all(waitUntilPromises)

	expect(order).toEqual(['graph-start', 'graph-end', 'effects', 'event'])
	expect(mocks.processInboundDeliveryEffects).toHaveBeenCalledWith({
		env,
		userId: 'user-aaa',
		deliveryId: 'delivery-1',
		expectedFinalizationToken: 'token-1',
		durationMs: 12,
		waitUntil: expect.any(Function),
	})
	expect(mocks.mirrorMailboxDeliveryEventFromD1).toHaveBeenCalledWith({
		env,
		db: env.APP_DB,
		userId: 'user-aaa',
		eventId: 'delivery-1',
	})
})

test('graph failure does not skip D1 effects; effects failure skips event mirror and logs once', async () => {
	resetMocks()
	consoleError.mockImplementation(() => {})

	mocks.mirrorMailboxMessageGraphFromD1.mockResolvedValue({
		messageId: 'msg-1',
		message: { status: 'timeout' as const },
		events: [],
		eventsTruncated: false,
	})
	mocks.processInboundDeliveryEffects.mockRejectedValueOnce(
		new Error('effects exploded'),
	)

	await scheduleInboundReceivedTerminalWork({
		env: { APP_DB: {} } as unknown as Parameters<
			typeof scheduleInboundReceivedTerminalWork
		>[0]['env'],
		userId: 'user-bbb',
		messageId: 'msg-1',
		deliveryId: 'delivery-2',
		logLabel: 'Inbound email effect dispatch failed',
	})

	expect(mocks.processInboundDeliveryEffects).toHaveBeenCalledTimes(1)
	expect(mocks.mirrorMailboxDeliveryEventFromD1).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'Inbound email effect dispatch failed',
		expect.objectContaining({ message: 'effects exploded' }),
	)
})

test('received and rejected coordinators skip system:email owners', async () => {
	resetMocks()
	const env = { APP_DB: {} } as unknown as Parameters<
		typeof scheduleInboundReceivedTerminalWork
	>[0]['env']

	await scheduleInboundReceivedTerminalWork({
		env,
		userId: systemEmailOwnerId,
		messageId: 'msg-sys',
		deliveryId: 'delivery-sys',
		logLabel: 'System should not run',
	})
	await scheduleInboundRejectedTerminalWork({
		env,
		userId: systemEmailOwnerId,
		deliveryId: 'delivery-sys',
	})

	expect(mocks.mirrorMailboxMessageGraphFromD1).not.toHaveBeenCalled()
	expect(mocks.processInboundDeliveryEffects).not.toHaveBeenCalled()
	expect(mocks.mirrorMailboxDeliveryEventFromD1).not.toHaveBeenCalled()
})

test('rejected terminal schedules delivery-event mirror only', async () => {
	resetMocks()
	const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()
	const env = { APP_DB: {} } as unknown as Parameters<
		typeof scheduleInboundRejectedTerminalWork
	>[0]['env']

	await scheduleInboundRejectedTerminalWork({
		env,
		userId: 'user-ccc',
		deliveryId: 'delivery-3',
		ctx,
	})

	expect(waitUntilPromises).toHaveLength(1)
	await Promise.all(waitUntilPromises)
	expect(mocks.mirrorMailboxMessageGraphFromD1).not.toHaveBeenCalled()
	expect(mocks.processInboundDeliveryEffects).not.toHaveBeenCalled()
	expect(mocks.mirrorMailboxDeliveryEventFromD1).toHaveBeenCalledWith({
		env,
		db: env.APP_DB,
		userId: 'user-ccc',
		eventId: 'delivery-3',
	})
})
