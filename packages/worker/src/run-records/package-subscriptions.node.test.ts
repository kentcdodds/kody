import { expect, test, vi } from 'vitest'

const runErrorRecordedTopic = 'run.error.recorded'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

const {
	dispatchRunErrorSubscriptionEvents,
	runErrorRecordedTopic: exportedTopic,
} = await import('./package-subscriptions.ts')

function errorRun(overrides: Record<string, unknown> = {}) {
	return {
		id: 'run-1',
		surface: 'job',
		status: 'error',
		name: 'daily-sync',
		packageId: 'pkg-owner',
		kodyId: 'daily-sync',
		sourceId: 'source-owner',
		publishedCommit: 'commit-1',
		storageId: 'storage-1',
		jobId: 'job-1',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-07-27T12:00:00.000Z',
		finishedAt: '2026-07-27T12:00:01.000Z',
		durationMs: 1000,
		errorName: 'Error',
		errorMessage: 'boom',
		metadataJson: '{}',
		createdAt: '2026-07-27T12:00:00.000Z',
		updatedAt: '2026-07-27T12:00:01.000Z',
		...overrides,
	}
}

test('exports the locked run.error.recorded topic', () => {
	expect(exportedTopic).toBe(runErrorRecordedTopic)
})

test('run.error.recorded fans out only to the owning user packages', async () => {
	const savedPackage = {
		id: 'package-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'error-notifier',
		name: '@user/error-notifier',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@user/error-notifier',
			kody: {
				id: 'error-notifier',
				description: 'Error notifier',
				subscriptions: {
					[runErrorRecordedTopic]: {
						handler: './src/on-run-error.ts',
					},
				},
			},
		},
	})
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env
	const run = errorRun()

	const results = await dispatchRunErrorSubscriptionEvents({
		env,
		userId: 'user-1',
		run: run as never,
	})

	expect(results).toHaveLength(1)
	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'user-1',
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: runErrorRecordedTopic,
			idempotencyKey: `run-error:run-1:package-1:${runErrorRecordedTopic}`,
			source: 'run-records',
			params: expect.objectContaining({
				event: runErrorRecordedTopic,
				activity_url: 'https://example.com/account/activity/run-1',
				run: expect.objectContaining({
					id: 'run-1',
					surface: 'job',
					name: 'daily-sync',
					package_id: 'pkg-owner',
					kody_id: 'daily-sync',
					source_id: 'source-owner',
					published_commit: 'commit-1',
					storage_id: 'storage-1',
					job_id: 'job-1',
					workflow_id: null,
					invocation_id: null,
					session_id: null,
					parent_run_id: null,
					started_at: '2026-07-27T12:00:00.000Z',
					finished_at: '2026-07-27T12:00:01.000Z',
					duration_ms: 1000,
					error_name: 'Error',
					error_message: 'boom',
				}),
			}),
		}),
	)
	const params = mocks.invokePackageSubscription.mock.calls[0]?.[0]?.params as
		| Record<string, unknown>
		| undefined
	expect(params).not.toHaveProperty('metadata')
	expect(params?.['run']).not.toHaveProperty('metadata')
	expect(params?.['run']).not.toHaveProperty('logs')
})

test('skips dispatch for subscription-surface errors to prevent recursion', async () => {
	mocks.invokePackageSubscription.mockClear()
	mocks.listSavedPackagesByUserId.mockClear()
	const results = await dispatchRunErrorSubscriptionEvents({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
			APP_BASE_URL: 'https://example.com',
		} as Env,
		userId: 'user-1',
		run: errorRun({ surface: 'subscription' }) as never,
	})
	expect(results).toEqual([])
	expect(mocks.listSavedPackagesByUserId).not.toHaveBeenCalled()
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
})

test('skips dispatch for non-error terminal status', async () => {
	mocks.invokePackageSubscription.mockClear()
	mocks.listSavedPackagesByUserId.mockClear()
	const results = await dispatchRunErrorSubscriptionEvents({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
			APP_BASE_URL: 'https://example.com',
		} as Env,
		userId: 'user-1',
		run: errorRun({
			status: 'success',
			errorName: null,
			errorMessage: null,
		}) as never,
	})
	expect(results).toEqual([])
	expect(mocks.listSavedPackagesByUserId).not.toHaveBeenCalled()
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
})

test('does not throw when discovery or invocation infrastructure fails', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const matchingPackage = {
		id: 'package-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'error-notifier',
		name: '@user/error-notifier',
	}
	const brokenPackage = {
		id: 'package-2',
		userId: 'user-1',
		sourceId: 'source-2',
		kodyId: 'broken',
		name: '@user/broken',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([
		matchingPackage,
		brokenPackage,
	])
	mocks.loadPackageManifestBySourceId
		.mockResolvedValueOnce({
			manifest: {
				name: '@user/error-notifier',
				kody: {
					id: 'error-notifier',
					description: 'Error notifier',
					subscriptions: {
						[runErrorRecordedTopic]: {
							handler: './src/on-run-error.ts',
						},
					},
				},
			},
		})
		.mockRejectedValueOnce(new Error('manifest unavailable'))
	mocks.invokePackageSubscription.mockResolvedValueOnce({
		status: 503,
		body: { error: { code: 'artifact_preparation_failed' } },
	})

	await expect(
		dispatchRunErrorSubscriptionEvents({
			env: {
				APP_DB: {},
				BUNDLE_ARTIFACTS_KV: {},
				APP_BASE_URL: 'https://example.com',
			} as Env,
			userId: 'user-1',
			run: errorRun() as never,
		}),
	).resolves.toEqual([null])

	expect(warn).toHaveBeenCalled()
	warn.mockRestore()
})

test('does not throw when listing saved packages fails', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	mocks.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('D1 unavailable'),
	)
	mocks.invokePackageSubscription.mockClear()

	await expect(
		dispatchRunErrorSubscriptionEvents({
			env: {
				APP_DB: {},
				BUNDLE_ARTIFACTS_KV: {},
				APP_BASE_URL: 'https://example.com',
			} as Env,
			userId: 'user-1',
			run: errorRun() as never,
		}),
	).resolves.toEqual([])

	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
	expect(warn).toHaveBeenCalledWith(
		'run.error.recorded package subscription discovery incomplete',
		expect.objectContaining({
			runId: 'run-1',
			errorCount: 1,
		}),
	)
	const warnPayload = warn.mock.calls.find(
		(call) =>
			call[0] ===
			'run.error.recorded package subscription discovery incomplete',
	)?.[1] as Record<string, unknown> | undefined
	expect(warnPayload).not.toHaveProperty('userId')
	warn.mockRestore()
})

test('isolates sibling handler failures with allSettled semantics', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const first = {
		id: 'package-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'notifier-a',
		name: '@user/notifier-a',
	}
	const second = {
		id: 'package-2',
		userId: 'user-1',
		sourceId: 'source-2',
		kodyId: 'notifier-b',
		name: '@user/notifier-b',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([first, second])
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			manifest: {
				name:
					input.sourceId === 'source-1'
						? '@user/notifier-a'
						: '@user/notifier-b',
				kody: {
					id: input.sourceId === 'source-1' ? 'notifier-a' : 'notifier-b',
					description: 'notifier',
					subscriptions: {
						[runErrorRecordedTopic]: {
							handler: './src/on-run-error.ts',
						},
					},
				},
			},
		}),
	)
	mocks.invokePackageSubscription
		.mockRejectedValueOnce(new Error('handler boom'))
		.mockResolvedValueOnce({ status: 200, body: { ok: true } })

	const results = await dispatchRunErrorSubscriptionEvents({
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
			APP_BASE_URL: 'https://example.com',
		} as Env,
		userId: 'user-1',
		run: errorRun() as never,
	})

	expect(results).toEqual([null, { status: 200, body: { ok: true } }])
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
	warn.mockRestore()
})
