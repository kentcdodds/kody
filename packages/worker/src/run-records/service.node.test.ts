import { expect, test, vi } from 'vitest'

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

test('finishRunRecord dispatches run.error.recorded after a persisted error', async () => {
	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	mocks.finishRun.mockClear()
	const env = createEnv()
	const handle = beginRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'job', name: 'daily', jobId: 'job-1' },
	})
	expect(handle).not.toBeNull()

	await finishRunRecord({
		env,
		handle,
		status: 'error',
		error: new Error('boom'),
	})

	expect(mocks.finishRun).toHaveBeenCalledTimes(1)
	expect(mocks.dispatchRunErrorSubscriptionEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			run: expect.objectContaining({
				id: handle!.id,
				status: 'error',
				surface: 'job',
				errorName: 'Error',
				errorMessage: 'boom',
			}),
		}),
	)
})

test('finishRunRecord does not dispatch for success or subscription surface', async () => {
	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	const env = createEnv()

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
})

test('recordRunRecord error path also dispatches through finishRunRecord', async () => {
	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	const env = createEnv()
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
})

test('finishRunRecord does not dispatch when finishRun RPC fails', async () => {
	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	mocks.finishRun.mockRejectedValueOnce(new Error('do unavailable'))
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const env = createEnv()
	const handle = beginRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'job', name: 'daily' },
	})
	await finishRunRecord({
		env,
		handle,
		status: 'error',
		error: new Error('boom'),
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()
	warn.mockRestore()
})

test('finishRunRecord swallows dispatch failures', async () => {
	mocks.dispatchRunErrorSubscriptionEvents.mockRejectedValueOnce(
		new Error('dispatch exploded'),
	)
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const env = createEnv()
	const handle = beginRunRecord({
		env,
		userId: 'user-1',
		context: { surface: 'webhook', name: 'hook' },
	})
	await expect(
		finishRunRecord({
			env,
			handle,
			status: 'error',
			error: new Error('boom'),
		}),
	).resolves.toBeUndefined()
	expect(warn).toHaveBeenCalledWith(
		'run-error-subscription-dispatch-failed',
		expect.any(Error),
	)
	warn.mockRestore()
})
