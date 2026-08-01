import { expect, test, vi } from 'vitest'
import type * as ScheduledLanesModule from './scheduled-lanes.ts'

const mocks = vi.hoisted(() => ({
	getScheduledLanes: vi.fn(() => [
		'reconcile_artifacts_pushes',
		'repo_session_cleanup',
	]),
	runScheduledLaneWithFailureIsolation: vi.fn(),
}))

vi.mock('./scheduled-lanes.ts', async (importOriginal) => {
	const original = await importOriginal<typeof ScheduledLanesModule>()
	return {
		...original,
		getScheduledLanes: mocks.getScheduledLanes,
		runScheduledLaneWithFailureIsolation:
			mocks.runScheduledLaneWithFailureIsolation,
	}
})

const { dispatchScheduledLanes, handleScheduledDispatchQueue } =
	await import('./scheduled-dispatch-queue.ts')

function createQueueMessage(input: {
	id: string
	lane: 'reconcile_artifacts_pushes' | 'repo_session_cleanup'
}) {
	return {
		id: input.id,
		timestamp: new Date(),
		attempts: 1,
		body: {
			lane: input.lane,
			scheduledTime: Date.parse('2026-08-01T06:00:00.000Z'),
			cron: '*/5 * * * *',
		},
		ack: vi.fn(),
		retry: vi.fn(),
	} as unknown as Message<unknown>
}

function createBatch(message: Message<unknown>) {
	return {
		queue: 'kody-scheduled-dispatch',
		messages: [message],
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<unknown>
}

test('scheduled dispatch enqueues due lanes as independent queue messages', async () => {
	const send = vi.fn(async () => undefined)
	const env = {
		SCHEDULED_DISPATCH_QUEUE: { send },
	} as unknown as Env
	const controller = {
		scheduledTime: Date.parse('2026-08-01T06:00:00.000Z'),
		cron: '*/5 * * * *',
		noRetry() {},
	} satisfies ScheduledController

	await dispatchScheduledLanes({ controller, env })

	expect(send).toHaveBeenCalledTimes(2)
	expect(send).toHaveBeenNthCalledWith(1, {
		lane: 'reconcile_artifacts_pushes',
		scheduledTime: controller.scheduledTime,
		cron: controller.cron,
	})
	expect(send).toHaveBeenNthCalledWith(2, {
		lane: 'repo_session_cleanup',
		scheduledTime: controller.scheduledTime,
		cron: controller.cron,
	})
})

test('a deliberately slow lane invocation does not delay its sibling invocation', async () => {
	let releaseSlowLane: (() => void) | undefined
	const slowLane = new Promise<void>((resolve) => {
		releaseSlowLane = resolve
	})
	mocks.runScheduledLaneWithFailureIsolation.mockImplementation(
		async ({ message }: { message: { lane: string } }) => {
			if (message.lane === 'reconcile_artifacts_pushes') {
				await slowLane
			}
			return 'completed'
		},
	)
	const slowMessage = createQueueMessage({
		id: 'slow',
		lane: 'reconcile_artifacts_pushes',
	})
	const siblingMessage = createQueueMessage({
		id: 'sibling',
		lane: 'repo_session_cleanup',
	})

	const slowInvocation = handleScheduledDispatchQueue(
		createBatch(slowMessage),
		{} as Env,
		{} as ExecutionContext,
	)
	const siblingInvocation = handleScheduledDispatchQueue(
		createBatch(siblingMessage),
		{} as Env,
		{} as ExecutionContext,
	)

	await siblingInvocation
	expect(siblingMessage.ack).toHaveBeenCalledTimes(1)
	expect(slowMessage.ack).not.toHaveBeenCalled()

	releaseSlowLane?.()
	await slowInvocation
	expect(slowMessage.ack).toHaveBeenCalledTimes(1)
})
