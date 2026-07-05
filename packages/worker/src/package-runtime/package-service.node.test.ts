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

vi.mock('#mcp/run-codemode-registry.ts', () => ({
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
const recordUsageSpy = vi
	.spyOn(usageModule, 'recordUsage')
	.mockResolvedValue(undefined)

const {
	PackageServiceInstance,
	buildPackageServiceStorageId,
	buildServiceRuntimeUsageEvent,
	resolveServiceRuntimeUsageOutcome,
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

function createPackageSource(mode: 'bounded' | 'persistent') {
	return {
		manifest: {
			kody: {
				id: '@scope/package-1',
				services: {
					'realtime-supervisor': {
						entry: 'services/realtime-supervisor.ts',
						mode,
						timeoutMs: mode === 'bounded' ? 30_000 : null,
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
	recordUsageSpy.mockClear()
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
				nextStatus: 'stopped',
			}),
		).toEqual({
			userId: 'user-123',
			eventType: 'service_runtime',
			entityId: 'package-1:realtime-supervisor',
			durationMs: 3_000,
			outcome: 'success',
		})
		expect(resolveServiceRuntimeUsageOutcome('stopped')).toBe('success')
		expect(resolveServiceRuntimeUsageOutcome('error')).toBe('error')
	} finally {
		recordUsageSpy.mockRestore()
		vi.useRealTimers()
	}
})
