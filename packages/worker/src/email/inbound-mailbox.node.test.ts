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
	authorityGet: vi.fn(async () => ({ state: 'received' as const })),
	createAuthority: vi.fn(),
	processInboundDeliveryEffects: vi.fn(async () => ({
		outcome: 'complete' as const,
	})),
}))

vi.mock('./mailbox-live-mirror.ts', () => ({
	mirrorMailboxMessageGraphFromD1: mocks.mirrorMailboxMessageGraphFromD1,
}))

vi.mock('./inbound-delivery-authority.ts', () => ({
	createUserInboundDeliveryAuthority: mocks.createAuthority,
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
	mocks.authorityGet.mockReset()
	mocks.createAuthority.mockReset()
	mocks.processInboundDeliveryEffects.mockReset()
	mocks.mirrorMailboxMessageGraphFromD1.mockResolvedValue({
		messageId: 'msg-1',
		message: { status: 'mirrored' as const },
		events: [],
		eventsTruncated: false,
	})
	mocks.authorityGet.mockResolvedValue({ state: 'received' as const })
	mocks.createAuthority.mockReturnValue({ get: mocks.authorityGet })
	mocks.processInboundDeliveryEffects.mockResolvedValue({
		outcome: 'complete' as const,
	})
}

test('received terminal work orders graph then effects then authority snapshot via waitUntil', async () => {
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
	mocks.authorityGet.mockImplementation(async () => {
		order.push('event')
		return { state: 'received' as const }
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
	expect(mocks.authorityGet).toHaveBeenCalledWith('delivery-1')
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
	expect(mocks.authorityGet).not.toHaveBeenCalled()
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
	expect(mocks.authorityGet).not.toHaveBeenCalled()
})

test('rejected terminal schedules authority snapshot repair only', async () => {
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
	expect(mocks.authorityGet).toHaveBeenCalledWith('delivery-3')
})

test('rejected terminal contains and logs projection repair failures', async () => {
	resetMocks()
	consoleError.mockImplementation(() => {})
	mocks.authorityGet.mockRejectedValueOnce(new Error('projection unavailable'))
	const { ctx, waitUntilPromises } = createCapturedWaitUntilContext()

	await scheduleInboundRejectedTerminalWork({
		env: { APP_DB: {} } as unknown as Parameters<
			typeof scheduleInboundRejectedTerminalWork
		>[0]['env'],
		userId: 'user-ddd',
		deliveryId: 'delivery-4',
		ctx,
	})

	expect(waitUntilPromises).toHaveLength(1)
	await expect(Promise.all(waitUntilPromises)).resolves.toEqual([undefined])
	expect(consoleError).toHaveBeenCalledWith(
		'Inbound email rejection projection repair failed',
		expect.objectContaining({ message: 'projection unavailable' }),
	)
})

test('rejected terminal contains synchronous authority construction failures', async () => {
	resetMocks()
	consoleError.mockImplementation(() => {})
	mocks.createAuthority.mockImplementation(() => {
		throw new Error('MAILBOX binding unavailable')
	})

	await expect(
		scheduleInboundRejectedTerminalWork({
			env: { APP_DB: {} } as unknown as Parameters<
				typeof scheduleInboundRejectedTerminalWork
			>[0]['env'],
			userId: 'user-sync-construction',
			deliveryId: 'delivery-sync-construction',
		}),
	).resolves.toBeUndefined()
	expect(consoleError).toHaveBeenCalledWith(
		'Inbound email rejection projection repair failed',
		expect.objectContaining({ message: 'MAILBOX binding unavailable' }),
	)
})
