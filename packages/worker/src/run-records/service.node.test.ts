import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	dispatchRunErrorSubscriptionEvents: vi.fn(async () => []),
	finishRun: vi.fn(async () => ({ ok: true })),
	startRun: vi.fn(async () => ({ ok: true })),
	recordSuccessfulPackageRun: vi.fn(async () => {}),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: mocks.dispatchRunErrorSubscriptionEvents,
}))

vi.mock('#worker/usage/activation.ts', () => ({
	recordSuccessfulPackageRun: mocks.recordSuccessfulPackageRun,
}))

const { beginRunRecord, finishRunRecord, recordRunRecord } =
	await import('./service.ts')

function createEnv() {
	return {
		RUN_LOG: {
			idFromName: () => ({ toString: () => 'run-log-id' }),
			get: () => ({
				startRun: mocks.startRun,
				finishRun: mocks.finishRun,
			}),
		},
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as unknown as Env
}

test('finishRunRecord dispatches run.error.recorded only for persisted non-subscription errors', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.dispatchRunErrorSubscriptionEvents.mockReset()
	mocks.finishRun.mockReset()
	mocks.finishRun.mockResolvedValue({ ok: true })
	mocks.dispatchRunErrorSubscriptionEvents.mockResolvedValue([])
	const env = createEnv()

	const errorHandle = beginRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'job', name: 'daily', jobId: 'job-1' },
	})
	expect(errorHandle).not.toBeNull()
	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		error: new Error('boom'),
	})
	expect(mocks.finishRun).toHaveBeenCalledTimes(1)
	expect(mocks.dispatchRunErrorSubscriptionEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			run: expect.objectContaining({
				id: errorHandle!.id,
				status: 'error',
				surface: 'job',
				errorName: 'Error',
				errorMessage: 'boom',
			}),
		}),
	)

	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	const successHandle = beginRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'job', name: 'ok' },
	})
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()

	const subscriptionHandle = beginRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'subscription', name: 'run.error.recorded' },
	})
	await finishRunRecord({
		env,
		handle: subscriptionHandle,
		status: 'error',
		error: new Error('handler failed'),
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()

	await recordRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'execute', name: 'adhoc' },
		status: 'error',
		error: new Error('execute failed'),
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			run: expect.objectContaining({
				status: 'error',
				surface: 'execute',
				errorMessage: 'execute failed',
			}),
		}),
	)

	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	mocks.finishRun.mockRejectedValueOnce(new Error('do unavailable'))
	const rpcFailHandle = beginRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'job', name: 'daily' },
	})
	await finishRunRecord({
		env,
		handle: rpcFailHandle,
		status: 'error',
		error: new Error('boom'),
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()

	mocks.dispatchRunErrorSubscriptionEvents.mockRejectedValueOnce(
		new Error('dispatch exploded'),
	)
	const swallowHandle = beginRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'webhook', name: 'hook' },
	})
	await expect(
		finishRunRecord({
			env,
			handle: swallowHandle,
			status: 'error',
			error: new Error('boom'),
		}),
	).resolves.toBeUndefined()
	expect(consoleWarn).toHaveBeenCalledWith(
		'run-error-subscription-dispatch-failed',
		expect.any(Error),
	)
})
