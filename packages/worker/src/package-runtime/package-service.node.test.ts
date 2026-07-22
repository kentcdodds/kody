import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	runBundledModuleWithRegistry: vi.fn(),
	createPackageEventTools: vi.fn(() => ({})),
	createPackageRuntimeInvokeTools: vi.fn(() => ({})),
}))

vi.mock('@sentry/cloudflare', () => ({
	instrumentDurableObjectWithSentry: (
		_getOptions: unknown,
		durableObjectClass: unknown,
	) => durableObjectClass,
}))

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		protected readonly ctx: DurableObjectState
		protected readonly env: Env

		constructor(ctx: DurableObjectState, env: Env) {
			this.ctx = ctx
			this.env = env
		}
	},
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		mockModule.loadPublishedBundleArtifactByIdentity(...args),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runBundledModuleWithRegistry: (...args: Array<unknown>) =>
		mockModule.runBundledModuleWithRegistry(...args),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	createPackageEventTools: (...args: Array<unknown>) =>
		mockModule.createPackageEventTools(...args),
	createPackageRuntimeInvokeTools: (...args: Array<unknown>) =>
		mockModule.createPackageRuntimeInvokeTools(...args),
}))

const usageModule = await import('#worker/usage/record-usage.ts')
const recordUsageSpy = vi.spyOn(usageModule, 'recordUsage')

const {
	PackageServiceInstance,
	buildPackageServiceStorageId,
	buildServiceRuntimeUsageEvent,
	computePackageServiceRetryDelayMs,
} = await import('./package-service.ts')

const serviceBinding = {
	userId: 'user-123',
	packageId: 'package-1',
	kodyId: '@scope/package-1',
	sourceId: 'source-1',
	baseUrl: 'https://example.invalid',
	serviceName: 'realtime-supervisor',
}

const savedPackage = {
	id: 'package-1',
	sourceId: 'source-1',
	kodyId: '@scope/package-1',
}

function createPackageSource(
	mode: 'bounded' | 'persistent',
	options?: { autoStart?: boolean },
) {
	return {
		manifest: {
			kody: {
				id: '@scope/package-1',
				services: {
					'realtime-supervisor': {
						entry: 'services/realtime-supervisor.ts',
						mode,
						timeoutMs: mode === 'bounded' ? 30_000 : null,
						...(options?.autoStart === true ? { autoStart: true } : {}),
					},
				},
			},
		},
		files: {
			'services/realtime-supervisor.ts': 'export default async function() {}',
		},
		source: {
			published_commit: 'abc123',
		},
	}
}

function createPackageServiceState() {
	const persistedEntries = new Map<string, unknown>()
	let alarmAt: number | null = null
	const waitUntilTasks: Array<Promise<unknown>> = []

	return {
		persistedEntries,
		waitUntilTasks,
		state: {
			storage: {
				get: vi.fn(async (key: string) => persistedEntries.get(key)),
				put: vi.fn(async (key: string, value: unknown) => {
					persistedEntries.set(key, value)
				}),
				setAlarm: vi.fn(async (value: Date | number) => {
					alarmAt = value instanceof Date ? value.valueOf() : Number(value)
				}),
				deleteAlarm: vi.fn(async () => {
					alarmAt = null
				}),
			},
			waitUntil: vi.fn((promise: Promise<unknown>) => {
				waitUntilTasks.push(promise)
			}),
			blockConcurrencyWhile: vi.fn((callback: () => Promise<void>) =>
				callback(),
			),
		} as unknown as DurableObjectState,
		getAlarmAt() {
			return alarmAt
		},
	}
}

async function waitForRestoreState(state: DurableObjectState) {
	const blockConcurrencyWhile = state.blockConcurrencyWhile as unknown as {
		mock: { results: Array<{ value: Promise<void> | undefined }> }
	}
	const blockPromise = blockConcurrencyWhile.mock.results[0]?.value
	if (!blockPromise) {
		throw new Error('Expected blockConcurrencyWhile to return restore promise.')
	}
	await blockPromise
}

async function createPackageServiceInstance(env: Env = {} as Env) {
	const created = createPackageServiceState()
	const instance = new PackageServiceInstance(created.state, env)
	await waitForRestoreState(created.state)
	return { instance, ...created }
}

async function flushWaitUntilTasks(waitUntilTasks: Array<Promise<unknown>>) {
	await Promise.all(waitUntilTasks)
}

function resetMocks() {
	mockModule.getSavedPackageById.mockReset()
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.loadPublishedBundleArtifactByIdentity.mockReset()
	mockModule.runBundledModuleWithRegistry.mockReset()
	mockModule.createPackageEventTools.mockReset()
	mockModule.createPackageRuntimeInvokeTools.mockReset()
	// The global `mockReset: true` config restores the spy's real
	// implementation before every test; re-stub so recordUsage does not run
	// against the stub env and log `usage-rollup-failed`.
	recordUsageSpy.mockClear()
	recordUsageSpy.mockResolvedValue(undefined)
}

function setupSavedPackage(mode: 'bounded' | 'persistent') {
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		createPackageSource(mode),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		artifact: {
			mainModule: 'main',
			modules: {},
		},
	})
}

test('buildPackageServiceStorageId creates stable per-service storage ids', () => {
	expect(buildPackageServiceStorageId('package-1', 'realtime-supervisor')).toBe(
		'service:package-1:realtime-supervisor',
	)
	expect(buildPackageServiceStorageId('package-1', 'guild sync')).toBe(
		'service:package-1:guild%20sync',
	)
	expect(buildPackageServiceStorageId('package-1', 'a:b/c')).toBe(
		'service:package-1:a%3Ab%2Fc',
	)
})

test('package service run finalization records service_runtime usage for success and failure', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))

	try {
		setupSavedPackage('bounded')
		mockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
			vi.setSystemTime(new Date('2026-07-05T12:00:05.000Z'))
			return { result: { ok: true }, error: null }
		})

		const boundedEnv = { APP_DB: {} } as Env
		const bounded = await createPackageServiceInstance(boundedEnv)
		const boundedStart = await bounded.instance.fetch(
			new Request('https://package-service.invalid/service/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ binding: serviceBinding }),
			}),
		)
		expect(boundedStart.status).toBe(200)
		await flushWaitUntilTasks(bounded.waitUntilTasks)

		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(boundedEnv, {
			userId: 'user-123',
			eventType: 'service_runtime',
			entityId: 'package-1:realtime-supervisor',
			durationMs: 5_000,
			outcome: 'success',
		})

		resetMocks()
		setupSavedPackage('persistent')
		mockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
			vi.setSystemTime(new Date('2026-07-05T12:01:10.000Z'))
			return { result: null, error: 'service crashed' }
		})

		const persistentEnv = { APP_DB: {} } as Env
		const persistent = await createPackageServiceInstance(persistentEnv)
		vi.setSystemTime(new Date('2026-07-05T12:01:00.000Z'))
		const persistentStart = await persistent.instance.fetch(
			new Request('https://package-service.invalid/service/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ binding: serviceBinding }),
			}),
		)
		expect(persistentStart.status).toBe(200)
		await flushWaitUntilTasks(persistent.waitUntilTasks)

		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(persistentEnv, {
			userId: 'user-123',
			eventType: 'service_runtime',
			entityId: 'package-1:realtime-supervisor',
			durationMs: 10_000,
			outcome: 'error',
		})
		expect(
			mockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4],
		).toMatchObject({
			executorTimeoutMs: null,
		})

		expect(
			buildServiceRuntimeUsageEvent({
				binding: serviceBinding,
				startedAt: '2026-07-05T12:00:00.000Z',
				finishedAtMs: Date.parse('2026-07-05T12:00:03.000Z'),
				failed: false,
			}),
		).toEqual({
			userId: 'user-123',
			eventType: 'service_runtime',
			entityId: 'package-1:realtime-supervisor',
			durationMs: 3_000,
			outcome: 'success',
		})
		// A run that threw while a stop was requested still counts as an error
		// even though its terminal service status is 'stopped'.
		expect(
			buildServiceRuntimeUsageEvent({
				binding: serviceBinding,
				startedAt: '2026-07-05T12:00:00.000Z',
				finishedAtMs: Date.parse('2026-07-05T12:00:03.000Z'),
				failed: true,
			}),
		).toMatchObject({ outcome: 'error' })

		// Crash while stop was requested: terminal status is 'stopped' but the
		// metered outcome must be 'error'.
		resetMocks()
		setupSavedPackage('bounded')
		const stoppingEnv = { APP_DB: {} } as Env
		const stopping = await createPackageServiceInstance(stoppingEnv)
		mockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
			await stopping.instance.fetch(
				new Request('https://package-service.invalid/service/stop', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ binding: serviceBinding }),
				}),
			)
			vi.setSystemTime(new Date('2026-07-05T12:02:04.000Z'))
			throw new Error('crashed while stopping')
		})
		vi.setSystemTime(new Date('2026-07-05T12:02:00.000Z'))
		const stoppingStart = await stopping.instance.fetch(
			new Request('https://package-service.invalid/service/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ binding: serviceBinding }),
			}),
		)
		expect(stoppingStart.status).toBe(200)
		await flushWaitUntilTasks(stopping.waitUntilTasks)
		const stoppingUsageCalls = recordUsageSpy.mock.calls.filter(
			([, event]) => event.eventType === 'service_runtime',
		)
		expect(stoppingUsageCalls).toHaveLength(1)
		expect(stoppingUsageCalls[0]?.[1]).toMatchObject({
			userId: 'user-123',
			entityId: 'package-1:realtime-supervisor',
			durationMs: 4_000,
			outcome: 'error',
		})
	} finally {
		recordUsageSpy.mockRestore()
		vi.useRealTimers()
	}
})

test('durable object restore meters an eviction-orphaned in-flight run without a duration', async () => {
	resetMocks()
	const restoreUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const restoreEnv = { APP_DB: {} } as Env
	const restored = createPackageServiceState()
	restored.persistedEntries.set('package-service-state', {
		binding: serviceBinding,
		autoStart: false,
		mode: 'persistent',
		timeoutMs: null,
		stopRequested: false,
		currentRunId: 'run-evicted',
		nextAlarmAt: null,
		nextAlarmSource: null,
		lastStartedAt: '2026-07-05T11:00:00.000Z',
		lastStoppedAt: null,
		status: 'running',
		lastError: null,
		lastResult: null,
		lastRunFinishedAt: null,
	})

	try {
		const instance = new PackageServiceInstance(restored.state, restoreEnv)
		await waitForRestoreState(restored.state)
		await flushWaitUntilTasks(restored.waitUntilTasks)

		expect(restoreUsageSpy).toHaveBeenCalledTimes(1)
		expect(restoreUsageSpy).toHaveBeenCalledWith(restoreEnv, {
			userId: 'user-123',
			eventType: 'service_runtime',
			entityId: 'package-1:realtime-supervisor',
			outcome: 'success',
		})
		expect(restoreUsageSpy.mock.calls[0]?.[1]?.durationMs).toBeUndefined()
		expect(instance).toBeTruthy()

		// An idle restore (no in-flight run) records nothing.
		restoreUsageSpy.mockClear()
		const idle = createPackageServiceState()
		idle.persistedEntries.set('package-service-state', {
			binding: serviceBinding,
			autoStart: false,
			mode: 'bounded',
			timeoutMs: null,
			stopRequested: false,
			currentRunId: null,
			nextAlarmAt: null,
			nextAlarmSource: null,
			lastStartedAt: '2026-07-05T11:00:00.000Z',
			lastStoppedAt: '2026-07-05T11:05:00.000Z',
			status: 'stopped',
			lastError: null,
			lastResult: null,
			lastRunFinishedAt: '2026-07-05T11:05:00.000Z',
		})
		new PackageServiceInstance(idle.state, restoreEnv)
		await waitForRestoreState(idle.state)
		await flushWaitUntilTasks(idle.waitUntilTasks)
		expect(restoreUsageSpy).not.toHaveBeenCalled()
	} finally {
		restoreUsageSpy.mockRestore()
	}
})

test('computePackageServiceRetryDelayMs doubles from the base delay to a 15-minute cap with jitter', () => {
	const atJitterMax = () => 1
	const atJitterMin = () => 0
	expect(
		computePackageServiceRetryDelayMs({ consecutiveFailureCount: 0 }),
	).toBe(5_000)
	expect(
		computePackageServiceRetryDelayMs({
			consecutiveFailureCount: 1,
			random: atJitterMax,
		}),
	).toBe(5_000)
	// Equal jitter spreads a retry between half and the full nominal delay.
	expect(
		computePackageServiceRetryDelayMs({
			consecutiveFailureCount: 1,
			random: atJitterMin,
		}),
	).toBe(2_500)
	expect(
		computePackageServiceRetryDelayMs({
			consecutiveFailureCount: 2,
			random: atJitterMax,
		}),
	).toBe(10_000)
	expect(
		computePackageServiceRetryDelayMs({
			consecutiveFailureCount: 3,
			random: atJitterMax,
		}),
	).toBe(20_000)
	expect(
		computePackageServiceRetryDelayMs({
			consecutiveFailureCount: 8,
			random: atJitterMax,
		}),
	).toBe(640_000)
	// 5s * 2^8 exceeds the cap, so the ninth consecutive failure pins to 15m.
	expect(
		computePackageServiceRetryDelayMs({
			consecutiveFailureCount: 9,
			random: atJitterMax,
		}),
	).toBe(900_000)
	expect(
		computePackageServiceRetryDelayMs({
			consecutiveFailureCount: 50,
			random: atJitterMax,
		}),
	).toBe(900_000)
	expect(
		computePackageServiceRetryDelayMs({
			consecutiveFailureCount: 50,
			random: atJitterMin,
		}),
	).toBe(450_000)
})

test('auto-start crash loops back off exponentially and reset after a successful run', async () => {
	resetMocks()
	const usageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1)
	vi.useFakeTimers()
	try {
		const startAt = new Date('2026-07-05T12:00:00.000Z')
		vi.setSystemTime(startAt)
		mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
		mockModule.loadPackageSourceBySourceId.mockResolvedValue(
			createPackageSource('bounded', { autoStart: true }),
		)
		mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
			artifact: {
				mainModule: 'main',
				modules: {},
			},
		})
		mockModule.runBundledModuleWithRegistry.mockRejectedValue(
			new Error('service crashed'),
		)

		const created = createPackageServiceState()
		created.persistedEntries.set('package-service-state', {
			binding: serviceBinding,
			autoStart: true,
			mode: 'bounded',
			timeoutMs: 30_000,
			stopRequested: false,
			currentRunId: null,
			nextAlarmAt: startAt.toISOString(),
			nextAlarmSource: 'auto-start',
			lastStartedAt: null,
			lastStoppedAt: null,
			status: 'stopped',
			lastError: null,
			lastResult: null,
			lastRunFinishedAt: null,
			consecutiveFailureCount: 0,
		})
		const instance = new PackageServiceInstance(created.state, {
			APP_DB: {},
		} as Env)
		await waitForRestoreState(created.state)

		const expectedDelays = [5_000, 10_000, 20_000]
		for (const [index, expectedDelay] of expectedDelays.entries()) {
			await instance.alarm()
			await flushWaitUntilTasks(created.waitUntilTasks)
			expect(created.getAlarmAt()).toBe(startAt.valueOf() + expectedDelay)
			const persisted = created.persistedEntries.get(
				'package-service-state',
			) as { consecutiveFailureCount: number }
			expect(persisted.consecutiveFailureCount).toBe(index + 1)
		}

		mockModule.runBundledModuleWithRegistry.mockResolvedValue({
			result: { ok: true },
			error: null,
		})
		await instance.alarm()
		await flushWaitUntilTasks(created.waitUntilTasks)
		// A successful run resets the crash-loop backoff to the base delay.
		expect(created.getAlarmAt()).toBe(startAt.valueOf() + 5_000)
		const persistedAfterSuccess = created.persistedEntries.get(
			'package-service-state',
		) as { consecutiveFailureCount: number }
		expect(persistedAfterSuccess.consecutiveFailureCount).toBe(0)
	} finally {
		randomSpy.mockRestore()
		usageSpy.mockRestore()
		vi.useRealTimers()
	}
})

test('durable object restore keeps the persisted crash-loop backoff after eviction', async () => {
	resetMocks()
	const usageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1)
	vi.useFakeTimers()
	try {
		const restoredAt = new Date('2026-07-05T13:00:00.000Z')
		vi.setSystemTime(restoredAt)
		const restored = createPackageServiceState()
		restored.persistedEntries.set('package-service-state', {
			binding: serviceBinding,
			autoStart: true,
			mode: 'bounded',
			timeoutMs: 30_000,
			stopRequested: false,
			currentRunId: 'run-evicted',
			nextAlarmAt: null,
			nextAlarmSource: null,
			lastStartedAt: '2026-07-05T12:59:00.000Z',
			lastStoppedAt: null,
			status: 'running',
			lastError: 'service crashed',
			lastResult: null,
			lastRunFinishedAt: null,
			consecutiveFailureCount: 4,
		})
		new PackageServiceInstance(restored.state, { APP_DB: {} } as Env)
		await waitForRestoreState(restored.state)
		await flushWaitUntilTasks(restored.waitUntilTasks)

		// The retry after eviction honors the persisted failure count
		// (5s * 2^3 = 40s) instead of resetting to the base delay.
		expect(restored.getAlarmAt()).toBe(restoredAt.valueOf() + 40_000)
		const persisted = restored.persistedEntries.get(
			'package-service-state',
		) as { consecutiveFailureCount: number }
		expect(persisted.consecutiveFailureCount).toBe(4)
	} finally {
		randomSpy.mockRestore()
		usageSpy.mockRestore()
		vi.useRealTimers()
	}
})
