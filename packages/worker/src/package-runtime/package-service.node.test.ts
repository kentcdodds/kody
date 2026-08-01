import { expect, test, vi } from 'vitest'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

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

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		DurableObject: class {
			protected readonly ctx: DurableObjectState
			protected readonly env: Env

			constructor(ctx: DurableObjectState, env: Env) {
				this.ctx = ctx
				this.env = env
			}
		},
	}
})

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
	projectPackageServiceStatus,
	upsertPackageServiceState,
	deletePackageServiceState,
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
				deleteAll: vi.fn(async () => {
					persistedEntries.clear()
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

/**
 * Drain UserMeter shadow (and other promptly settling) waitUntil tasks without
 * hanging on long-lived background service runs also scheduled via waitUntil.
 */
async function drainSettledWaitUntilTasks(
	waitUntilTasks: Array<Promise<unknown>>,
	fromIndex = 0,
) {
	const pending = waitUntilTasks.slice(fromIndex)
	await Promise.all(
		pending.map(async (task) => {
			const state = { settled: false }
			void Promise.resolve(task).then(
				() => {
					state.settled = true
				},
				() => {
					state.settled = true
				},
			)
			for (let i = 0; i < 40; i++) {
				await Promise.resolve()
				if (state.settled) {
					await task
					return
				}
			}
		}),
	)
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

test('projectPackageServiceStatus maps stopping to running for entitlement slots', () => {
	expect(projectPackageServiceStatus('running')).toBe('running')
	expect(projectPackageServiceStatus('stopping')).toBe('running')
	expect(projectPackageServiceStatus('idle')).toBe('idle')
	expect(projectPackageServiceStatus('stopped')).toBe('stopped')
	expect(projectPackageServiceStatus('error')).toBe('error')
})

test('package service start and stop project liveness into package_service_states', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
	const upserts: Array<Array<unknown>> = []
	const deletes: Array<Array<unknown>> = []
	const appDb = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (query.includes('INSERT INTO package_service_states')) {
								upserts.push(params)
							}
							if (query.includes('DELETE FROM package_service_states')) {
								deletes.push(params)
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	try {
		setupSavedPackage('bounded')
		mockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
			vi.setSystemTime(new Date('2026-07-05T12:00:05.000Z'))
			return { result: { ok: true }, error: null }
		})

		const created = await createPackageServiceInstance({
			APP_DB: appDb,
		} as Env)
		const start = await created.instance.fetch(
			new Request('https://package-service.invalid/service/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ binding: serviceBinding }),
			}),
		)
		expect(start.status).toBe(200)
		expect(upserts[0]).toEqual([
			'user-123',
			'package-1',
			'realtime-supervisor',
			'running',
			'2026-07-05T12:00:00.000Z',
			'2026-07-05T12:00:00.000Z',
		])
		expect(created.getAlarmAt()).toBe(Date.parse('2026-07-05T13:00:00.000Z'))

		await flushWaitUntilTasks(created.waitUntilTasks)
		expect(upserts.at(-1)).toEqual([
			'user-123',
			'package-1',
			'realtime-supervisor',
			'stopped',
			null,
			'2026-07-05T12:00:05.000Z',
		])

		await created.instance.fetch(
			new Request('https://package-service.invalid/service/purge', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ binding: serviceBinding }),
			}),
		)
		expect(deletes).toContainEqual([
			'user-123',
			'package-1',
			'realtime-supervisor',
		])
	} finally {
		vi.useRealTimers()
	}
})

test('upsertPackageServiceState and deletePackageServiceState write the expected SQL', async () => {
	const statements: Array<{ sql: string; params: Array<unknown> }> = []
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					statements.push({ sql: query, params })
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	await upsertPackageServiceState({
		db,
		userId: 'user-1',
		packageId: 'pkg-1',
		serviceName: 'worker',
		status: 'running',
		startedAt: '2026-07-05T12:00:00.000Z',
		updatedAt: '2026-07-05T12:00:00.000Z',
	})
	expect(statements[0]?.sql).toContain('INSERT INTO package_service_states')
	expect(statements[0]?.params).toEqual([
		'user-1',
		'pkg-1',
		'worker',
		'running',
		'2026-07-05T12:00:00.000Z',
		'2026-07-05T12:00:00.000Z',
	])

	await upsertPackageServiceState({
		db,
		userId: 'user-1',
		packageId: 'pkg-1',
		serviceName: 'worker',
		status: 'stopped',
		startedAt: '2026-07-05T12:00:00.000Z',
		updatedAt: '2026-07-05T12:01:00.000Z',
	})
	expect(statements[1]?.params[4]).toBeNull()

	await deletePackageServiceState({
		db,
		userId: 'user-1',
		packageId: 'pkg-1',
		serviceName: 'worker',
	})
	expect(statements[2]?.sql).toContain('DELETE FROM package_service_states')
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

test('package service restore projects current state into package_service_states', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T14:00:00.000Z'))
	const upserts: Array<Array<unknown>> = []
	const appDb = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (query.includes('INSERT INTO package_service_states')) {
								upserts.push(params)
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database

	try {
		const restored = createPackageServiceState()
		restored.persistedEntries.set('package-service-state', {
			binding: serviceBinding,
			autoStart: false,
			mode: 'bounded',
			timeoutMs: 30_000,
			stopRequested: false,
			currentRunId: null,
			nextAlarmAt: null,
			nextAlarmSource: null,
			lastStartedAt: '2026-07-05T13:00:00.000Z',
			lastStoppedAt: '2026-07-05T13:05:00.000Z',
			status: 'stopped',
			lastError: null,
			lastResult: { ok: true },
			lastRunFinishedAt: '2026-07-05T13:05:00.000Z',
			consecutiveFailureCount: 0,
		})
		new PackageServiceInstance(restored.state, { APP_DB: appDb } as Env)
		await waitForRestoreState(restored.state)

		expect(upserts).toEqual([
			[
				'user-123',
				'package-1',
				'realtime-supervisor',
				'stopped',
				null,
				'2026-07-05T14:00:00.000Z',
			],
		])
	} finally {
		vi.useRealTimers()
	}
})

function createRecordingPackageServiceDb() {
	const upserts: Array<Array<unknown>> = []
	const deletes: Array<Array<unknown>> = []
	const appDb = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (query.includes('INSERT INTO package_service_states')) {
								upserts.push(params)
							}
							if (query.includes('DELETE FROM package_service_states')) {
								deletes.push(params)
							}
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
	return { appDb, upserts, deletes }
}

function createNoopPackageServiceDb() {
	return {
		prepare() {
			return {
				bind() {
					return {
						async run() {
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function packageServiceShadowRow(
	meter: ReturnType<typeof createInMemoryUserMeterEnv>,
	userId: string,
	packageId: string,
	serviceName: string,
) {
	return meter.packageServicesByUser
		.get(userId)
		?.get(`${packageId}\0${serviceName}`)
}

async function postPackageService(
	instance: InstanceType<typeof PackageServiceInstance>,
	action: 'start' | 'stop' | 'purge',
	binding: typeof serviceBinding = serviceBinding,
) {
	return instance.fetch(
		new Request(`https://package-service.invalid/service/${action}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ binding }),
		}),
	)
}

test('package service start/heartbeat/stop/purge shadow UserMeter transitions', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
	const { appDb, upserts, deletes } = createRecordingPackageServiceDb()
	const meter = createInMemoryUserMeterEnv()

	try {
		setupSavedPackage('persistent')
		mockModule.runBundledModuleWithRegistry.mockImplementation(
			() => new Promise(() => {}),
		)

		const created = await createPackageServiceInstance({
			APP_DB: appDb,
			USER_METER: meter.env.USER_METER,
		} as Env)
		const start = await postPackageService(created.instance, 'start')
		expect(start.status).toBe(200)
		// D1 projection stays on the awaited lifecycle path.
		expect(upserts[0]?.[3]).toBe('running')
		await drainSettledWaitUntilTasks(created.waitUntilTasks)
		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toMatchObject({
			status: 'running',
			startedAt: '2026-07-05T12:00:00.000Z',
			sourceUpdatedAt: '2026-07-05T12:00:00.000Z',
			revision: 1,
		})
		expect(created.getAlarmAt()).toBe(Date.parse('2026-07-05T13:00:00.000Z'))

		vi.setSystemTime(new Date('2026-07-05T13:00:00.000Z'))
		const afterStartWaitUntilCount = created.waitUntilTasks.length
		await created.instance.alarm()
		await drainSettledWaitUntilTasks(
			created.waitUntilTasks,
			afterStartWaitUntilCount,
		)
		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toMatchObject({
			status: 'running',
			sourceUpdatedAt: '2026-07-05T13:00:00.000Z',
			revision: 2,
		})
		expect(created.getAlarmAt()).toBe(Date.parse('2026-07-05T14:00:00.000Z'))

		const afterHeartbeatWaitUntilCount = created.waitUntilTasks.length
		await postPackageService(created.instance, 'stop')
		await drainSettledWaitUntilTasks(
			created.waitUntilTasks,
			afterHeartbeatWaitUntilCount,
		)
		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toMatchObject({
			status: 'running',
			sourceUpdatedAt: '2026-07-05T13:00:00.000Z',
			revision: 3,
		})

		const afterStopWaitUntilCount = created.waitUntilTasks.length
		await postPackageService(created.instance, 'purge')
		await drainSettledWaitUntilTasks(
			created.waitUntilTasks,
			afterStopWaitUntilCount,
		)
		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toBeUndefined()
		expect(deletes).toContainEqual([
			'user-123',
			'package-1',
			'realtime-supervisor',
		])
		expect(upserts.length).toBeGreaterThanOrEqual(3)
	} finally {
		vi.useRealTimers()
	}
})

test('package service serializes gated UserMeter shadows so purge stays deleted and running→stopped cannot regress', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
	const { appDb } = createRecordingPackageServiceDb()
	const meter = createInMemoryUserMeterEnv()

	type Gate = {
		release: () => void
		promise: Promise<void>
		label: string
	}
	const gates: Array<Gate> = []
	const callOrder: Array<string> = []
	const baseStub = meter.env.USER_METER.get(
		meter.env.USER_METER.idFromName('user-123'),
	)

	function pushGate(label: string): Gate {
		const gate: Gate = {
			label,
			release: () => {},
			promise: Promise.resolve(),
		}
		gate.promise = new Promise<void>((resolve) => {
			gate.release = resolve
		})
		gates.push(gate)
		return gate
	}

	const gatedMeter = {
		USER_METER: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			get: () => ({
				async upsertPackageServiceState(
					input: Parameters<typeof baseStub.upsertPackageServiceState>[0],
				) {
					const gate = pushGate(`upsert:${input.status}`)
					await gate.promise
					callOrder.push(`upsert:${input.status}`)
					return baseStub.upsertPackageServiceState(input)
				},
				async deletePackageServiceState(
					input: Parameters<typeof baseStub.deletePackageServiceState>[0],
				) {
					const gate = pushGate('delete')
					await gate.promise
					callOrder.push('delete')
					return baseStub.deletePackageServiceState(input)
				},
			}),
		},
	}

	async function settleMicrotasks() {
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
	}

	async function waitForGate(label: string) {
		for (let i = 0; i < 100; i++) {
			if (gates.some((gate) => gate.label === label)) return
			await Promise.resolve()
		}
		throw new Error(`Timed out waiting for gated shadow op ${label}.`)
	}

	try {
		setupSavedPackage('bounded')
		mockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
			vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
			return { result: { ok: true }, error: null }
		})

		const created = await createPackageServiceInstance({
			APP_DB: appDb,
			USER_METER: gatedMeter.USER_METER,
		} as Env)

		const start = await postPackageService(created.instance, 'start')
		expect(start.status).toBe(200)
		// Lifecycle returned while the first shadow hop is still gated.
		expect(created.waitUntilTasks.length).toBeGreaterThanOrEqual(2)
		await waitForGate('upsert:running')
		expect(gates.map((gate) => gate.label)).toEqual(['upsert:running'])
		expect(callOrder).toEqual([])
		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toBeUndefined()

		// Finish the bounded background run while the running shadow stays gated so
		// the same-ms stopped upsert is chained behind it (not started yet).
		const backgroundRunTask = created.waitUntilTasks[1]
		expect(backgroundRunTask).toBeDefined()
		await backgroundRunTask
		await settleMicrotasks()
		expect(gates.map((gate) => gate.label)).toEqual(['upsert:running'])
		expect(callOrder).toEqual([])

		// Same-ms running→stopped: stopped cannot begin until running is released,
		// so a reordered drain cannot let stopped win first and then regress.
		gates[0]?.release()
		await waitForGate('upsert:stopped')
		expect(callOrder).toEqual(['upsert:running'])
		expect(gates.map((gate) => gate.label)).toEqual([
			'upsert:running',
			'upsert:stopped',
		])
		gates[1]?.release()
		await drainSettledWaitUntilTasks(created.waitUntilTasks)
		expect(callOrder).toEqual(['upsert:running', 'upsert:stopped'])
		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toMatchObject({
			status: 'stopped',
			sourceUpdatedAt: '2026-07-05T12:00:00.000Z',
		})

		callOrder.length = 0
		gates.length = 0
		const beforePurgeWaitUntilCount = created.waitUntilTasks.length
		const purge = await postPackageService(created.instance, 'purge')
		expect(purge.status).toBe(200)
		await waitForGate('upsert:stopped')
		// Purge schedules stopped upsert then delete; delete cannot start first.
		expect(gates.map((gate) => gate.label)).toEqual(['upsert:stopped'])
		expect(callOrder).toEqual([])

		// Prefer settling the trailing waitUntil chain entry first while the head
		// upsert is still gated. Serialization keeps delete behind the upsert, so
		// the purge final state stays deleted instead of resurrecting.
		const trailingPurgeChain = created.waitUntilTasks.at(-1)
		expect(trailingPurgeChain).toBeDefined()
		let trailingSettled = false
		void Promise.resolve(trailingPurgeChain).then(() => {
			trailingSettled = true
		})
		await settleMicrotasks()
		expect(trailingSettled).toBe(false)
		expect(callOrder).toEqual([])

		gates[0]?.release()
		await waitForGate('delete')
		expect(callOrder).toEqual(['upsert:stopped'])
		expect(gates.map((gate) => gate.label)).toEqual([
			'upsert:stopped',
			'delete',
		])
		expect(trailingSettled).toBe(false)
		gates[1]?.release()
		await drainSettledWaitUntilTasks(
			created.waitUntilTasks,
			beforePurgeWaitUntilCount,
		)
		expect(trailingSettled).toBe(true)
		expect(callOrder).toEqual(['upsert:stopped', 'delete'])
		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toBeUndefined()
	} finally {
		vi.useRealTimers()
	}
})

test('package service lifecycle does not await a gated UserMeter shadow', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
	const { appDb, upserts } = createRecordingPackageServiceDb()
	let releaseShadow!: () => void
	const shadowGate = new Promise<void>((resolve) => {
		releaseShadow = resolve
	})
	let shadowFinished = false
	const gatedMeter = {
		USER_METER: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			get: () => ({
				async upsertPackageServiceState() {
					await shadowGate
					shadowFinished = true
					return {
						applied: true,
						created: true,
						state: {
							packageId: 'package-1',
							serviceName: 'realtime-supervisor',
							status: 'running' as const,
							startedAt: '2026-07-05T12:00:00.000Z',
							sourceUpdatedAt: '2026-07-05T12:00:00.000Z',
							revision: 1,
							updatedAt: '2026-07-05T12:00:00.000Z',
							mirrorUpdatedAt: 'r/00000000000000000001',
						},
					}
				},
				async deletePackageServiceState() {
					return { deleted: true }
				},
			}),
		},
	}

	try {
		setupSavedPackage('persistent')
		mockModule.runBundledModuleWithRegistry.mockImplementation(
			() => new Promise(() => {}),
		)

		const created = await createPackageServiceInstance({
			APP_DB: appDb,
			USER_METER: gatedMeter.USER_METER,
		} as Env)
		const start = await postPackageService(created.instance, 'start')
		expect(start.status).toBe(200)
		expect(upserts[0]).toEqual([
			'user-123',
			'package-1',
			'realtime-supervisor',
			'running',
			'2026-07-05T12:00:00.000Z',
			'2026-07-05T12:00:00.000Z',
		])
		// Lifecycle returned while the shadow DO hop is still gated.
		expect(shadowFinished).toBe(false)
		expect(created.waitUntilTasks.length).toBeGreaterThan(0)

		releaseShadow()
		await drainSettledWaitUntilTasks(created.waitUntilTasks)
		expect(shadowFinished).toBe(true)
	} finally {
		vi.useRealTimers()
	}
})

test('package service UserMeter shadow failure cannot break D1 projection or lifecycle', async () => {
	resetMocks()
	silenceExpectedConsoleWarns(['package-service-user-meter-shadow-failed'])
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
	const { appDb, upserts } = createRecordingPackageServiceDb()
	const failingMeter = {
		USER_METER: {
			idFromName: (name: string) => ({ name, toString: () => name }),
			get: () => ({
				async upsertPackageServiceState() {
					throw new Error('shadow write failed')
				},
				async deletePackageServiceState() {
					throw new Error('shadow delete failed')
				},
			}),
		},
	}

	try {
		setupSavedPackage('bounded')
		mockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
			vi.setSystemTime(new Date('2026-07-05T12:00:05.000Z'))
			return { result: { ok: true }, error: null }
		})

		const created = await createPackageServiceInstance({
			APP_DB: appDb,
			USER_METER: failingMeter.USER_METER,
		} as Env)
		const start = await postPackageService(created.instance, 'start')
		expect(start.status).toBe(200)
		expect(upserts[0]).toEqual([
			'user-123',
			'package-1',
			'realtime-supervisor',
			'running',
			'2026-07-05T12:00:00.000Z',
			'2026-07-05T12:00:00.000Z',
		])
		await flushWaitUntilTasks(created.waitUntilTasks)
		expect(upserts.at(-1)).toEqual([
			'user-123',
			'package-1',
			'realtime-supervisor',
			'stopped',
			null,
			'2026-07-05T12:00:05.000Z',
		])
		expect(consoleWarn).toHaveBeenCalledWith(
			'package-service-user-meter-shadow-failed',
			expect.any(Error),
		)

		const beforePurgeWaitUntilCount = created.waitUntilTasks.length
		const purge = await postPackageService(created.instance, 'purge')
		expect(purge.status).toBe(200)
		await drainSettledWaitUntilTasks(
			created.waitUntilTasks,
			beforePurgeWaitUntilCount,
		)
		expect(consoleWarn).toHaveBeenCalledWith(
			'package-service-user-meter-shadow-failed',
			expect.any(Error),
		)
	} finally {
		vi.useRealTimers()
	}
})

test('package service UserMeter shadows are isolated per owning user', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T12:00:00.000Z'))
	const appDb = createNoopPackageServiceDb()
	const meter = createInMemoryUserMeterEnv()
	const otherBinding = {
		...serviceBinding,
		userId: 'user-other',
		packageId: 'package-2',
		kodyId: '@scope/package-2',
	}

	try {
		setupSavedPackage('bounded')
		mockModule.runBundledModuleWithRegistry.mockImplementation(
			() => new Promise(() => {}),
		)
		mockModule.getSavedPackageById.mockImplementation(
			async (_db: unknown, input: { packageId: string }) =>
				input.packageId === 'package-2'
					? {
							id: 'package-2',
							sourceId: 'source-1',
							kodyId: '@scope/package-2',
						}
					: savedPackage,
		)
		mockModule.loadPackageSourceBySourceId.mockImplementation(async () =>
			createPackageSource('bounded'),
		)

		const first = await createPackageServiceInstance({
			APP_DB: appDb,
			USER_METER: meter.env.USER_METER,
		} as Env)
		const second = await createPackageServiceInstance({
			APP_DB: appDb,
			USER_METER: meter.env.USER_METER,
		} as Env)

		await postPackageService(first.instance, 'start')
		await postPackageService(second.instance, 'start', otherBinding)
		await drainSettledWaitUntilTasks(first.waitUntilTasks)
		await drainSettledWaitUntilTasks(second.waitUntilTasks)

		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toMatchObject({ status: 'running' })
		expect(
			packageServiceShadowRow(
				meter,
				'user-other',
				'package-2',
				'realtime-supervisor',
			),
		).toMatchObject({ status: 'running' })
		expect(meter.packageServicesByUser.get('user-123')?.size).toBe(1)
		expect(meter.packageServicesByUser.get('user-other')?.size).toBe(1)
		expect(
			meter.packageServicesByUser
				.get('user-123')
				?.has('package-2\0realtime-supervisor'),
		).toBe(false)
	} finally {
		vi.useRealTimers()
	}
})

test('package service restore shadows current D1 projection into UserMeter', async () => {
	resetMocks()
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-07-05T14:00:00.000Z'))
	const appDb = createNoopPackageServiceDb()
	const meter = createInMemoryUserMeterEnv()

	try {
		const restored = createPackageServiceState()
		restored.persistedEntries.set('package-service-state', {
			binding: serviceBinding,
			autoStart: false,
			mode: 'bounded',
			timeoutMs: 30_000,
			stopRequested: false,
			currentRunId: null,
			nextAlarmAt: null,
			nextAlarmSource: null,
			lastStartedAt: '2026-07-05T13:00:00.000Z',
			lastStoppedAt: '2026-07-05T13:05:00.000Z',
			status: 'error',
			lastError: 'boom',
			lastResult: null,
			lastRunFinishedAt: '2026-07-05T13:05:00.000Z',
			consecutiveFailureCount: 1,
		})
		new PackageServiceInstance(restored.state, {
			APP_DB: appDb,
			USER_METER: meter.env.USER_METER,
		} as Env)
		await waitForRestoreState(restored.state)
		await drainSettledWaitUntilTasks(restored.waitUntilTasks)

		expect(
			packageServiceShadowRow(
				meter,
				'user-123',
				'package-1',
				'realtime-supervisor',
			),
		).toMatchObject({
			status: 'error',
			startedAt: null,
			sourceUpdatedAt: '2026-07-05T14:00:00.000Z',
			revision: 1,
		})
	} finally {
		vi.useRealTimers()
	}
})
