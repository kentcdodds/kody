import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	dispatchRunErrorSubscriptionEvents: vi.fn(async () => []),
	finishRun: vi.fn(async () => ({ ok: true })),
	startRun: vi.fn(async () => ({ ok: true })),
	listPackageRunSuccesses: vi.fn(async () => []),
	listActivationMilestones: vi.fn(async () => []),
	isActivationInitialized: vi.fn(async () => ({ initialized: false })),
	importActivationState: vi.fn(async () => ({ initialized: true })),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: mocks.dispatchRunErrorSubscriptionEvents,
}))

const {
	beginRunRecord,
	ensureActivationStateSeeded,
	finishRunRecord,
	isMissingD1RelationError,
	listActivationMilestones,
	listPackageRunSuccesses,
	recordRunRecord,
} = await import('./service.ts')

function createEnv(overrides: Partial<Env> = {}) {
	return {
		RUN_LOG: {
			idFromName: () => ({ toString: () => 'run-log-id' }),
			get: () => ({
				startRun: mocks.startRun,
				finishRun: mocks.finishRun,
				listPackageRunSuccesses: mocks.listPackageRunSuccesses,
				listActivationMilestones: mocks.listActivationMilestones,
				isActivationInitialized: mocks.isActivationInitialized,
				importActivationState: mocks.importActivationState,
			}),
		},
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
		...overrides,
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
		context: { surface: 'job', name: 'ok', packageId: 'pkg-a' },
	})
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()
	expect(mocks.finishRun).toHaveBeenCalledTimes(2)

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

test('isMissingD1RelationError treats no-such-table and no-such-column as empty', () => {
	expect(isMissingD1RelationError(new Error('no such table: jobs'))).toBe(true)
	expect(
		isMissingD1RelationError(
			new Error('D1_ERROR: no such column: legacy_seeded: SQLITE_ERROR'),
		),
	).toBe(true)
	expect(isMissingD1RelationError(new Error('D1 unavailable'))).toBe(false)
})

test('activation seed treats no-such-column as successful empty import', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.isActivationInitialized.mockReset()
	mocks.importActivationState.mockReset()
	mocks.isActivationInitialized.mockResolvedValue({ initialized: false })
	mocks.importActivationState.mockResolvedValue({ initialized: true })

	const env = createEnv({
		APP_DB: {
			prepare: () => ({
				bind: () => ({
					all: async () => {
						throw new Error(
							'D1_ERROR: no such column: success_count: SQLITE_ERROR',
						)
					},
				}),
			}),
		} as unknown as D1Database,
	})

	await ensureActivationStateSeeded({ env, userId: 'user-1' })
	expect(mocks.importActivationState).toHaveBeenCalledTimes(1)
	expect(mocks.importActivationState).toHaveBeenCalledWith({
		packageRunSuccesses: [],
		milestones: [],
	})
	expect(consoleWarn).not.toHaveBeenCalledWith(
		'run-log-activation-seed-failed',
		expect.anything(),
	)
})

test('activation reads never throw when RunLog is missing or RPC fails', async () => {
	consoleWarn.mockImplementation(() => {})
	const envWithoutBinding = {} as Env
	await expect(
		listPackageRunSuccesses({ env: envWithoutBinding, userId: 'user-1' }),
	).resolves.toEqual([])
	await expect(
		listActivationMilestones({ env: envWithoutBinding, userId: 'user-1' }),
	).resolves.toEqual([])

	mocks.listPackageRunSuccesses.mockRejectedValueOnce(
		new Error('do unavailable'),
	)
	mocks.listActivationMilestones.mockRejectedValueOnce(
		new Error('do unavailable'),
	)
	const env = createEnv()
	await expect(
		listPackageRunSuccesses({ env, userId: 'user-1' }),
	).resolves.toEqual([])
	await expect(
		listActivationMilestones({ env, userId: 'user-1' }),
	).resolves.toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'package-run-successes-list-failed',
		expect.any(Error),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'activation-milestones-list-failed',
		expect.any(Error),
	)
})
