import { readFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import {
	buildPackageStorageId,
	createPackageStorageAccessDeniedMessage,
} from '#worker/storage-runner.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as ModuleGraph from './module-graph.ts'
import type * as PublishedBundleArtifacts from './published-bundle-artifacts.ts'

async function extractCreatePackageAppWorkerSource() {
	const sourceText = await readFile(
		new URL('./package-app.ts', import.meta.url),
		'utf8',
	)
	const start = sourceText.indexOf(
		'function createWorkflowsProxy(runtimeBridge) {',
	)
	const end = sourceText.indexOf(
		'\nfunction createAuthenticatedFetchHelper',
		start,
	)
	if (start < 0 || end < 0) {
		throw new Error('createWorkflowsProxy source was not found.')
	}
	const proxySource = sourceText
		.slice(start, end)
		.replaceAll('\\\\', '\\')
		.replaceAll('\\`', '`')
		.replaceAll('\\${', '${')
	return `${proxySource}; return createWorkflowsProxy(runtimeBridge);`
}

async function extractCreateKodyProxySource() {
	const sourceText = await readFile(
		new URL('./package-app.ts', import.meta.url),
		'utf8',
	)
	const start = sourceText.indexOf('function createKodyProxy(runtimeBridge) {')
	const end = sourceText.indexOf('\nfunction createRealtimeProxy', start)
	if (start < 0 || end < 0) {
		throw new Error('createKodyProxy source was not found.')
	}
	const proxySource = sourceText
		.slice(start, end)
		.replaceAll('\\\\', '\\')
		.replaceAll('\\`', '`')
		.replaceAll('\\${', '${')
	return `${proxySource}; return createKodyProxy(runtimeBridge);`
}

async function createKodyProxyForTest(runtimeBridge: unknown) {
	return new Function('runtimeBridge', await extractCreateKodyProxySource())(
		runtimeBridge,
	) as Record<string, unknown>
}

async function createWorkflowsProxyForTest(runtimeBridge: unknown) {
	return new Function(
		'runtimeBridge',
		await extractCreatePackageAppWorkerSource(),
	)(runtimeBridge) as {
		create(input: unknown): Promise<unknown>
	}
}

async function collectQueryParamNamesForTest(url: URL) {
	const sourceText = await readFile(
		new URL('./package-app.ts', import.meta.url),
		'utf8',
	)
	const start = sourceText.indexOf('function collectQueryParamNames(url) {')
	const end = sourceText.indexOf('\n\nasync function startRuntimeRun', start)
	if (start < 0 || end < 0) {
		throw new Error('collectQueryParamNames source was not found.')
	}
	const functionSource = sourceText
		.slice(start, end)
		.replaceAll('\\\\', '\\')
		.replaceAll('\\`', '`')
		.replaceAll('\\${', '${')
	return new Function(
		'url',
		`${functionSource}; return collectQueryParamNames(url);`,
	)(url) as Array<string>
}

test('package app kody proxy supports remote namespace calls', async () => {
	const calls: Array<{ name: string; args: unknown }> = []
	const kody = await createKodyProxyForTest({
		callCapability: async (input: { name: string; args: unknown }) => {
			calls.push(input)
			return { ok: true }
		},
	})

	await expect(
		(
			kody.remote as Record<
				string,
				Record<string, (args: unknown) => Promise<unknown>>
			>
		)['home']?.set_pin({ pin: '1234' }),
	).resolves.toEqual({ ok: true })
	expect(calls).toEqual([
		{
			name: 'remote:home:set_pin',
			args: { pin: '1234' },
		},
	])
	expect(() => kody['remote:home:set_pin']).toThrow(
		'Remote connector capability "remote:home:set_pin" is not available as a flat kody function.',
	)
})

test('package app workflows proxy validates required workflow input fields', async () => {
	const workflows = await createWorkflowsProxyForTest({
		workflowCreate: async (input: unknown) => input,
	})

	await expect(workflows.create(undefined)).rejects.toThrow(
		'workflows.create requires a workflow input object.',
	)
	await expect(workflows.create({})).rejects.toThrow(
		'workflows.create requires exactly one of exportName or code.',
	)
	await expect(
		workflows.create({
			exportName: './run-event',
			code: 'export default async function main() {}',
			runAt: '2026-05-03T12:00:00.000Z',
			idempotencyKey: 'event-key',
		}),
	).rejects.toThrow(
		'workflows.create requires exactly one of exportName or code.',
	)
	await expect(
		workflows.create({
			exportName: './run-event',
			code: '',
			runAt: '2026-05-03T12:00:00.000Z',
			idempotencyKey: 'event-key',
		}),
	).resolves.toEqual({
		exportName: './run-event',
		runAt: new Date('2026-05-03T12:00:00.000Z'),
		idempotencyKey: 'event-key',
	})
	await expect(
		workflows.create({
			exportName: './run-event',
			code: '',
		}),
	).resolves.toEqual({
		exportName: './run-event',
	})
	await expect(
		workflows.create({
			workflowName: 'shade-event',
			exportName: './run-event',
			runAt: 'not-a-date',
			idempotencyKey: 'event-key',
		}),
	).rejects.toThrow(
		'workflows.create requires a valid runAt ISO-8601 date-time string or Date.',
	)
	await expect(
		workflows.create({
			workflowName: 'shade-event',
			exportName: './run-event',
			runAt: 'May 3, 2026 12:00:00',
			idempotencyKey: 'event-key',
		}),
	).rejects.toThrow(
		'workflows.create requires a valid runAt ISO-8601 date-time string or Date.',
	)
})

test('package app workflows proxy forwards inline code workflow input', async () => {
	const workflows = await createWorkflowsProxyForTest({
		workflowCreate: async (input: unknown) => input,
	})
	const code = 'export default async function main() { return { ok: true } }'
	const result = await workflows.create({
		code,
		runAt: '2026-05-03T12:00:00.000Z',
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})

	expect(result).toEqual({
		code,
		runAt: new Date('2026-05-03T12:00:00.000Z'),
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})

	await expect(
		workflows.create({
			code,
			params: { eventId: 'event-2' },
		}),
	).resolves.toEqual({
		code,
		params: { eventId: 'event-2' },
	})
})

test('package app workflows proxy forwards validated input to runtime bridge', async () => {
	const workflows = await createWorkflowsProxyForTest({
		workflowCreate: async (input: unknown) => input,
	})
	const result = await workflows.create({
		workflowName: ' shade-event ',
		exportName: './run-event',
		runAt: '2026-05-03T12:00:00.000Z',
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})

	expect(result).toEqual({
		workflowName: ' shade-event ',
		exportName: './run-event',
		runAt: new Date('2026-05-03T12:00:00.000Z'),
		idempotencyKey: 'event-key',
		params: { eventId: 'event-1' },
	})
})

const packageAppRuntimeMock = vi.hoisted(() => ({
	buildKodyAppBundle: vi.fn(),
	hydrateKodyRuntimeModules: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	persistPublishedBundleArtifact: vi.fn(),
	assertPublishedSourceCanRebuildWithoutInstallingDeps: vi.fn(),
	getEntitySourceById: vi.fn(),
	packageAppRuntimeBridge: vi.fn((input: unknown) => input),
	resolvePackageMountedSecret: vi.fn(),
	beginRunRecord: vi.fn(),
	finishRunRecord: vi.fn(async () => {}),
}))

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return {
		...actual,
		exports: {
			...actual.exports,
			PackageAppRuntimeBridge: packageAppRuntimeMock.packageAppRuntimeBridge,
		},
	}
})

vi.mock('./module-graph.ts', async () => {
	const actual = await vi.importActual<typeof ModuleGraph>('./module-graph.ts')
	return {
		...actual,
		buildKodyAppBundle: (...args: Array<unknown>) =>
			packageAppRuntimeMock.buildKodyAppBundle(...args),
		hydrateKodyRuntimeModules: (...args: Array<unknown>) =>
			packageAppRuntimeMock.hydrateKodyRuntimeModules(...args),
	}
})

vi.mock('./published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifacts>(
		'./published-bundle-artifacts.ts',
	)
	return {
		...actual,
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity(...args),
		persistPublishedBundleArtifact: (...args: Array<unknown>) =>
			packageAppRuntimeMock.persistPublishedBundleArtifact(...args),
	}
})

vi.mock('./published-source-dependencies.ts', () => ({
	assertPublishedSourceCanRebuildWithoutInstallingDeps: (
		...args: Array<unknown>
	) =>
		packageAppRuntimeMock.assertPublishedSourceCanRebuildWithoutInstallingDeps(
			...args,
		),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		packageAppRuntimeMock.getEntitySourceById(...args),
}))

vi.mock('#mcp/secrets/package-access.ts', () => ({
	isPackageSecretAccessUnavailableError: (error: unknown) =>
		error instanceof Error && error.message === 'secret-unavailable',
	resolvePackageMountedSecret: (...args: Array<unknown>) =>
		packageAppRuntimeMock.resolvePackageMountedSecret(...args),
}))

vi.mock('#worker/run-records/service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/run-records/service.ts')>()
	return {
		...actual,
		beginRunRecord: (...args: Array<unknown>) =>
			packageAppRuntimeMock.beginRunRecord(...args),
		finishRunRecord: (...args: Array<unknown>) =>
			packageAppRuntimeMock.finishRunRecord(...args),
	}
})

function createPackageAppTestSource() {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package' as const,
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-30T00:00:00.000Z',
		updated_at: '2026-04-30T00:00:00.000Z',
	}
}

function createPackageAppTestManifest() {
	return {
		name: '@kody/example',
		kody: {
			id: 'example',
			description: 'Example package',
			app: {
				entry: 'app.js',
			},
		},
	}
}

function createPackageAppTestEnv() {
	const getEntrypoint = vi.fn(() => ({
		fetch: vi.fn(async () => new Response('ok')),
	}))
	return {
		env: {
			APP_DB: {},
			APP_LOADER: {
				load: vi.fn(() => ({
					getEntrypoint,
				})),
				get: vi.fn(() => ({
					getEntrypoint,
				})),
			},
		} as unknown as Env,
		getEntrypoint,
	}
}

function resetPackageAppRuntimeMocks() {
	packageAppRuntimeMock.buildKodyAppBundle.mockReset()
	packageAppRuntimeMock.hydrateKodyRuntimeModules.mockReset()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockReset()
	packageAppRuntimeMock.persistPublishedBundleArtifact.mockReset()
	packageAppRuntimeMock.assertPublishedSourceCanRebuildWithoutInstallingDeps.mockReset()
	packageAppRuntimeMock.getEntitySourceById.mockReset()
	packageAppRuntimeMock.resolvePackageMountedSecret.mockReset()
	packageAppRuntimeMock.beginRunRecord.mockReset()
	packageAppRuntimeMock.finishRunRecord.mockReset()
	packageAppRuntimeMock.packageAppRuntimeBridge.mockClear()
	packageAppRuntimeMock.finishRunRecord.mockResolvedValue(undefined)
	packageAppRuntimeMock.hydrateKodyRuntimeModules.mockImplementation(
		async ({ modules }: { modules: Record<string, string> }) => ({
			modules,
			dynamicDependencyPackageIds: [],
		}),
	)
}

const {
	buildPackageAppWorker,
	createPackageAppWorkerId,
	PackageAppRuntimeBridge,
} = await import('./package-app.ts')

const { redactedSecretText } =
	await import('#mcp/secrets/execution-secret-redactor.ts')

function createPackageAppRuntimeBridgeForTest(input?: {
	packageStorageGrantIds?: Array<string>
}) {
	const waitUntilTasks: Array<Promise<unknown>> = []
	const bridge = new PackageAppRuntimeBridge(
		{
			props: {
				baseUrl: 'https://example.com',
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
				packageId: 'package-1',
				kodyId: 'example',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				packageStorageGrantIds: input?.packageStorageGrantIds ?? ['package-1'],
			},
			waitUntil: (promise: Promise<unknown>) => {
				waitUntilTasks.push(promise)
			},
		} as never,
		{} as Env,
	)
	return { bridge, waitUntilTasks }
}

test('buildPackageAppWorker loads published app artifacts with artifactName null', async () => {
	resetPackageAppRuntimeMocks()
	const { env } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		{
			row: {
				id: 'artifact-row-1',
				artifactName: null,
				entryPoint: 'app.js',
			},
			artifact: {
				mainModule: 'dist/app.js',
				modules: {
					'dist/app.js':
						'export default { fetch() { return new Response("cached") } }',
				},
				dependencies: [],
				dynamicDependencies: [],
			},
		},
	)

	await buildPackageAppWorker({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-artifact-hit',
		savedPackage: {
			id: 'package-artifact-hit',
			kodyId: 'example-hit',
			name: '@kody/example-hit',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
		},
		source: createPackageAppTestSource(),
		manifest: createPackageAppTestManifest(),
		loadSourceFiles: async () => {
			throw new Error('full source load should be skipped on artifact hit')
		},
		runtime: {
			callerContext: {
				user: {
					userId: 'user-artifact-hit',
					email: 'artifact-hit@example.com',
					displayName: 'Artifact Hit User',
				},
			},
		} as never,
	})

	expect(
		packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledWith({
		env,
		userId: 'user-artifact-hit',
		sourceId: 'source-1',
		kind: 'app',
		artifactName: null,
		entryPoint: 'app.js',
	})
	expect(packageAppRuntimeMock.buildKodyAppBundle).not.toHaveBeenCalled()
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).not.toHaveBeenCalled()
})

test('buildPackageAppWorker acquires a fresh stub per request while reusing the built worker options', async () => {
	resetPackageAppRuntimeMocks()
	const { env } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		{
			row: {
				id: 'artifact-row-1',
				artifactName: null,
				entryPoint: 'app.js',
			},
			artifact: {
				mainModule: 'dist/app.js',
				modules: {
					'dist/app.js':
						'export default { fetch() { return new Response("cached") } }',
				},
				dependencies: [],
				dynamicDependencies: [],
			},
		},
	)

	const buildInput = {
		env,
		baseUrl: 'https://example.com',
		userId: 'user-stub-reuse',
		savedPackage: {
			id: 'package-stub-reuse',
			kodyId: 'example-stub-reuse',
			name: '@kody/example-stub-reuse',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
		},
		source: createPackageAppTestSource(),
		manifest: createPackageAppTestManifest(),
		runtime: {
			callerContext: {
				user: {
					userId: 'user-stub-reuse',
					email: 'stub-reuse@example.com',
					displayName: 'Stub Reuse User',
				},
			},
		} as never,
	}

	await buildPackageAppWorker(buildInput)
	await buildPackageAppWorker(buildInput)

	const loader = env.APP_LOADER as unknown as {
		get: ReturnType<typeof vi.fn>
		load: ReturnType<typeof vi.fn>
	}
	// The expensive build (artifact lookup + hydration) runs once; each request
	// still re-acquires a request-bound stub with the same stable worker id.
	expect(
		packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(1)
	expect(loader.get).toHaveBeenCalledTimes(2)
	expect(loader.load).not.toHaveBeenCalled()
	const [firstWorkerId] = loader.get.mock.calls[0] as [string]
	const [secondWorkerId] = loader.get.mock.calls[1] as [string]
	expect(firstWorkerId).toBe(secondWorkerId)
	expect(firstWorkerId).toMatch(/^package-app-/)
})

test('buildPackageAppWorker aligns dynamic worker compatibility with shared options', async () => {
	resetPackageAppRuntimeMocks()
	const { env } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		{
			row: {
				id: 'artifact-row-1',
				artifactName: null,
				entryPoint: 'app.js',
			},
			artifact: {
				mainModule: 'dist/app.js',
				modules: {
					'dist/app.js':
						'export default { fetch() { return new Response("cached") } }',
				},
				dependencies: [],
				dynamicDependencies: [],
			},
		},
	)

	await buildPackageAppWorker({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-compat',
		savedPackage: {
			id: 'package-compat',
			kodyId: 'example-compat',
			name: '@kody/example-compat',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
		},
		source: createPackageAppTestSource(),
		manifest: createPackageAppTestManifest(),
		runtime: {
			callerContext: {
				user: {
					userId: 'user-compat',
					email: 'compat@example.com',
					displayName: 'Compat User',
				},
			},
		} as never,
	})

	const loader = env.APP_LOADER as unknown as {
		get: ReturnType<typeof vi.fn>
	}
	const factory = loader.get.mock.calls[0]?.[1] as
		| (() => Record<string, unknown>)
		| undefined
	expect(factory).toBeTypeOf('function')
	expect(factory?.()).toMatchObject(createDynamicWorkerCompatibilityOptions())
})

test('package app worker exposes its public mount and records fetch query and response status', async () => {
	resetPackageAppRuntimeMocks()
	const { env } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		{
			row: {
				id: 'artifact-row-public-context',
				artifactName: null,
				entryPoint: 'app.js',
			},
			artifact: {
				mainModule: 'dist/app.js',
				modules: {
					'dist/app.js':
						'export default { fetch() { return new Response("ok", { status: 201 }) } }',
				},
				dependencies: [],
				dynamicDependencies: [],
			},
		},
	)

	await buildPackageAppWorker({
		env,
		baseUrl: 'https://app.kody.test',
		userId: 'user-public-context',
		savedPackage: {
			id: 'package-public-context',
			kodyId: 'renamed-app',
			name: '@current-owner/renamed-app',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
		},
		source: createPackageAppTestSource(),
		manifest: createPackageAppTestManifest(),
		runtime: {
			callerContext: {
				user: {
					email: 'owner@example.com',
					displayName: 'Owner',
				},
			} as never,
			servingUsername: 'serving-owner',
			hostedOrigin: 'https://packages.kody.test',
		},
	})

	const loader = env.APP_LOADER as unknown as {
		get: ReturnType<typeof vi.fn>
	}
	const factory = loader.get.mock.calls[0]?.[1] as
		| (() => {
				env: Record<string, unknown>
				modules: Record<string, string>
		  })
		| undefined
	const workerOptions = factory?.()
	expect(workerOptions?.env['__kodyPackageContext']).toEqual({
		packageId: 'package-public-context',
		kodyId: 'renamed-app',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		appBasePath: '/@serving-owner/packages/renamed-app',
		hostedUrl: 'https://packages.kody.test/@serving-owner/packages/renamed-app',
	})
	const wrapperSource = workerOptions?.modules['package-app-entry.js']
	expect(wrapperSource).toContain(
		'queryParamNames: collectQueryParamNames(requestUrl)',
	)
	expect(wrapperSource).toContain('httpStatus: response.status')

	const queryParamNames = await collectQueryParamNamesForTest(
		new URL(
			'https://packages.kody.test/callback?audio=1&code=oauth-code-secret&state=oauth-state-secret&audio=2',
		),
	)
	expect(queryParamNames).toEqual(['audio', 'code', 'state'])
	expect(JSON.stringify(queryParamNames)).not.toContain('oauth-code-secret')
	expect(JSON.stringify(queryParamNames)).not.toContain('oauth-state-secret')
})

test('createPackageAppWorkerId changes when compatibility settings change', async () => {
	const cacheKey = JSON.stringify([
		'user-compat-id',
		'package-compat-id',
		'example-compat-id',
		'source-1',
		'commit-1',
		'https://example.com',
		'compat@example.com',
		'Compat User',
	])
	const modules = {
		'package-app-entry.js':
			'export default { fetch() { return new Response("ok") } }',
	}
	const baseWorkerOptions = {
		...createDynamicWorkerCompatibilityOptions(),
		mainModule: 'package-app-entry.js',
		modules,
	}

	const baselineId = await createPackageAppWorkerId({
		cacheKey,
		workerOptions: baseWorkerOptions,
	})
	const dateChangedId = await createPackageAppWorkerId({
		cacheKey,
		workerOptions: {
			...baseWorkerOptions,
			compatibilityDate: '2025-06-01',
		},
	})
	const flagsChangedId = await createPackageAppWorkerId({
		cacheKey,
		workerOptions: {
			...baseWorkerOptions,
			compatibilityFlags: ['nodejs_compat'],
		},
	})
	const unchangedId = await createPackageAppWorkerId({
		cacheKey,
		workerOptions: baseWorkerOptions,
	})

	expect(baselineId).toMatch(/^package-app-/)
	expect(unchangedId).toBe(baselineId)
	expect(dateChangedId).not.toBe(baselineId)
	expect(flagsChangedId).not.toBe(baselineId)
	expect(dateChangedId).not.toBe(flagsChangedId)
})

test('buildPackageAppWorker persists rebuilt app artifacts with artifactName null', async () => {
	resetPackageAppRuntimeMocks()
	const { env } = createPackageAppTestEnv()
	const source = createPackageAppTestSource()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		null,
	)
	packageAppRuntimeMock.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js':
				'export default { fetch() { return new Response("fresh") } }',
		},
		dependencies: [],
		dynamicDependencies: [],
	})
	packageAppRuntimeMock.persistPublishedBundleArtifact.mockResolvedValue(
		'bundle-artifact:v1:source-1:commit-1:app:_:app.js',
	)

	await buildPackageAppWorker({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		savedPackage: {
			id: 'package-persist-miss',
			kodyId: 'example-miss',
			name: '@kody/example-miss',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
		},
		source,
		manifest: createPackageAppTestManifest(),
		loadSourceFiles: async () => ({
			'package.json': JSON.stringify(createPackageAppTestManifest()),
			'app.js':
				'export default { async fetch() { return new Response("ok") } }',
		}),
		runtime: {
			callerContext: {
				user: {
					userId: 'user-1',
					email: 'persist-miss@example.com',
					displayName: 'Persist Miss User',
				},
			},
		} as never,
	})

	expect(packageAppRuntimeMock.getEntitySourceById).not.toHaveBeenCalled()
	expect(packageAppRuntimeMock.buildKodyAppBundle).toHaveBeenCalledTimes(1)
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			source,
			kind: 'app',
			artifactName: null,
			entryPoint: 'app.js',
		}),
	)
})

test('buildPackageAppWorker rejects persisting artifacts for a source owned by another user', async () => {
	resetPackageAppRuntimeMocks()
	const { env } = createPackageAppTestEnv()
	const source = createPackageAppTestSource()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		null,
	)
	packageAppRuntimeMock.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js':
				'export default { fetch() { return new Response("fresh") } }',
		},
		dependencies: [],
		dynamicDependencies: [],
	})
	// The pre-resolved source belongs to user-1, so the fast path must be
	// skipped and the DB lookup (which finds nothing for this user) must fail.
	packageAppRuntimeMock.getEntitySourceById.mockResolvedValue(null)

	await expect(
		buildPackageAppWorker({
			env,
			baseUrl: 'https://example.com',
			userId: 'user-other',
			savedPackage: {
				id: 'package-other',
				kodyId: 'example-other',
				name: '@kody/example-other',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				manifestPath: 'package.json',
				sourceRoot: '/',
			},
			source,
			manifest: createPackageAppTestManifest(),
			loadSourceFiles: async () => ({
				'package.json': JSON.stringify(createPackageAppTestManifest()),
				'app.js':
					'export default { async fetch() { return new Response("ok") } }',
			}),
			runtime: {
				callerContext: {
					user: {
						userId: 'user-other',
						email: 'other@example.com',
						displayName: 'Other User',
					},
				},
			} as never,
		}),
	).rejects.toThrow('Saved package source "source-1" was not found.')

	expect(packageAppRuntimeMock.getEntitySourceById).toHaveBeenCalledTimes(1)
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).not.toHaveBeenCalled()
})

test('buildPackageAppWorker skips published artifact lookup when publishedCommit is null', async () => {
	resetPackageAppRuntimeMocks()
	const { env } = createPackageAppTestEnv()
	const source = {
		...createPackageAppTestSource(),
		published_commit: null,
	}
	packageAppRuntimeMock.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js':
				'export default { fetch() { return new Response("draft") } }',
		},
		dependencies: [],
	})

	await buildPackageAppWorker({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-unpublished',
		savedPackage: {
			id: 'package-unpublished',
			kodyId: 'example-draft',
			name: '@kody/example-draft',
			sourceId: 'source-1',
			publishedCommit: null,
			manifestPath: 'package.json',
			sourceRoot: '/',
		},
		source,
		manifest: createPackageAppTestManifest(),
		loadSourceFiles: async () => ({
			'package.json': JSON.stringify(createPackageAppTestManifest()),
			'app.js':
				'export default { async fetch() { return new Response("ok") } }',
		}),
		runtime: {
			callerContext: {
				user: {
					userId: 'user-unpublished',
					email: 'unpublished@example.com',
					displayName: 'Unpublished User',
				},
			},
		} as never,
	})

	expect(
		packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity,
	).not.toHaveBeenCalled()
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).not.toHaveBeenCalled()
	expect(packageAppRuntimeMock.buildKodyAppBundle).toHaveBeenCalledTimes(1)
})

test('package app worker source finishes run records via waitUntil', async () => {
	const sourceText = await readFile(
		new URL('./package-app.ts', import.meta.url),
		'utf8',
	)
	expect(sourceText).toContain(
		'executionCtx.waitUntil(runtimeBridge.packageRuntimeRunFinish(input));',
	)
	expect(sourceText).toContain('finishRuntimeRun(runtimeBridge, this.ctx, {')
	expect(sourceText).not.toContain('await finishRuntimeRun(')
})

test('package app runtime bridge redacts resolved secrets from run record logs and errors', async () => {
	resetPackageAppRuntimeMocks()
	const secretValue = 'pkg-app-secret-value-9f3c'
	packageAppRuntimeMock.resolvePackageMountedSecret.mockResolvedValue({
		value: secretValue,
	})
	let resolveFinish: (() => void) | undefined
	const finishGate = new Promise<void>((resolve) => {
		resolveFinish = resolve
	})
	packageAppRuntimeMock.finishRunRecord.mockImplementation(async () => {
		await finishGate
	})
	const { bridge, waitUntilTasks } = createPackageAppRuntimeBridgeForTest()
	const runHandle = {
		id: 'run-1',
		userId: 'user-1',
		startedAt: '2026-07-26T00:00:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'app_fetch' as const,
			packageId: 'package-1',
		},
	}

	await expect(
		bridge.packageSecretGet({ alias: 'api-token' }),
	).resolves.toEqual({ value: secretValue })

	await expect(
		bridge.packageRuntimeRunFinish({
			run: runHandle,
			status: 'error',
			logs: [
				{
					level: 'log',
					message: `token=${secretValue}`,
				},
				`also ${secretValue}`,
			],
			error: {
				name: 'Error',
				message: `boom ${secretValue}`,
			},
		}),
	).resolves.toEqual({ ok: true })

	// Finish is scheduled on waitUntil; the HTTP/RPC path must not await it.
	expect(waitUntilTasks).toHaveLength(1)
	expect(packageAppRuntimeMock.finishRunRecord).toHaveBeenCalledTimes(1)
	resolveFinish?.()
	await Promise.all(waitUntilTasks)

	expect(packageAppRuntimeMock.finishRunRecord).toHaveBeenCalledWith({
		env: {},
		handle: runHandle,
		status: 'error',
		logs: [
			{
				level: 'log',
				message: `token=${redactedSecretText}`,
			},
			`also ${redactedSecretText}`,
		],
		error: {
			name: 'Error',
			message: `boom ${redactedSecretText}`,
		},
	})
	const finishInput = packageAppRuntimeMock.finishRunRecord.mock
		.calls[0]?.[0] as {
		logs: Array<unknown>
		error: { message: string }
	}
	expect(JSON.stringify(finishInput.logs)).not.toContain(secretValue)
	expect(finishInput.error.message).not.toContain(secretValue)
})

test('package app runtime bridge adds response status to finish metadata', async () => {
	resetPackageAppRuntimeMocks()
	const { bridge, waitUntilTasks } = createPackageAppRuntimeBridgeForTest()
	const runHandle = {
		id: 'run-status',
		userId: 'user-1',
		startedAt: '2026-07-26T00:00:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'app_fetch' as const,
			packageId: 'package-1',
			metadata: {
				method: 'GET',
				queryParamNames: ['audio', 'code', 'state'],
			},
		},
	}

	await bridge.packageRuntimeRunFinish({
		run: runHandle,
		status: 'success',
		metadata: { httpStatus: 201 },
	})
	await Promise.all(waitUntilTasks)

	expect(packageAppRuntimeMock.finishRunRecord).toHaveBeenCalledWith({
		env: {},
		handle: {
			...runHandle,
			context: {
				...runHandle.context,
				metadata: {
					method: 'GET',
					queryParamNames: ['audio', 'code', 'state'],
					httpStatus: 201,
				},
			},
		},
		status: 'success',
		error: undefined,
		logs: undefined,
	})
})

test('package app runtime bridge redacts secrets from Error instances in finish payload', async () => {
	resetPackageAppRuntimeMocks()
	const secretValue = 'pkg-app-thrown-secret-value-4a1b'
	packageAppRuntimeMock.resolvePackageMountedSecret.mockResolvedValue({
		value: secretValue,
	})
	const { bridge, waitUntilTasks } = createPackageAppRuntimeBridgeForTest()

	await bridge.packageSecretGet({ alias: 'api-token' })
	await bridge.packageRuntimeRunFinish({
		run: null,
		status: 'error',
		logs: [{ level: 'error', message: secretValue }],
		error: new Error(`failed with ${secretValue}`),
	})
	await Promise.all(waitUntilTasks)

	const finishInput = packageAppRuntimeMock.finishRunRecord.mock
		.calls[0]?.[0] as {
		logs: Array<{ message: string }>
		error: Error
	}
	expect(finishInput.logs[0]?.message).toBe(redactedSecretText)
	expect(finishInput.error).toBeInstanceOf(Error)
	expect(finishInput.error.message).toBe(`failed with ${redactedSecretText}`)
	expect(finishInput.error.message).not.toContain(secretValue)
})

test('package app worker source binds __kodyPackageStorage in createRuntime', async () => {
	const sourceText = await readFile(
		new URL('./package-app.ts', import.meta.url),
		'utf8',
	)
	expect(sourceText).toContain('__kodyPackageStorage: (storagePackageId) => ({')
	expect(sourceText).toContain(
		"id: 'package:' + encodeURIComponent(storagePackageId),",
	)
	expect(sourceText).toContain('runtimeBridge.packageStorageGet({')
	expect(sourceText).toContain('runtimeBridge.packageStorageList({')
	expect(sourceText).toContain('runtimeBridge.packageStorageSql({')
	expect(sourceText).toContain('runtimeBridge.packageStorageSet({')
	expect(sourceText).toContain('runtimeBridge.packageStorageDelete({')
	expect(sourceText).toContain('runtimeBridge.packageStorageClear({')
	expect(sourceText).toContain('storage: undefined,')
	expect(sourceText).not.toContain('function createStorageProxy(')
	expect(sourceText).not.toContain("case 'storage_get':")
	expect(sourceText).not.toContain("case 'storage_clear':")
})

test('package app runtime bridge packageStorage methods grant by provenance and deny others', async () => {
	const { bridge } = createPackageAppRuntimeBridgeForTest({
		packageStorageGrantIds: ['package-1', 'dep-package'],
	})
	const getValue = vi.fn(async () => ({ value: 'granted-value' }))
	const setValue = vi.fn(async () => ({ ok: true }))
	const getStorageRunner = vi
		.spyOn(
			bridge as unknown as {
				getStorageRunner: (storageId: string) => unknown
			},
			'getStorageRunner',
		)
		.mockImplementation((storageId: string) => ({
			storageId,
			getValue,
			setValue,
			listValues: vi.fn(),
			sqlQuery: vi.fn(),
			deleteValue: vi.fn(),
			clearStorage: vi.fn(),
		}))
	vi.spyOn(
		bridge as unknown as {
			assertStorageWriteAllowed: (input: unknown) => Promise<void>
		},
		'assertStorageWriteAllowed',
	).mockResolvedValue(undefined)

	await expect(
		bridge.packageStorageGet({ packageId: 'package-1', key: 'count' }),
	).resolves.toEqual({ value: 'granted-value' })
	expect(getStorageRunner).toHaveBeenCalledWith(
		buildPackageStorageId('package-1'),
	)
	expect(getValue).toHaveBeenCalledWith({ key: 'count' })

	await expect(
		bridge.packageStorageSet({
			packageId: 'dep-package',
			key: 'flag',
			value: true,
		}),
	).resolves.toEqual({ ok: true })
	expect(getStorageRunner).toHaveBeenCalledWith(
		buildPackageStorageId('dep-package'),
	)
	expect(setValue).toHaveBeenCalledWith({ key: 'flag', value: true })

	await expect(
		bridge.packageStorageGet({ packageId: 'victim-package', key: 'secret' }),
	).rejects.toThrow(createPackageStorageAccessDeniedMessage('victim-package'))
	expect(getValue).toHaveBeenCalledTimes(2)

	await expect(
		bridge.packageStorageClear({ packageId: '   ' }),
	).rejects.toThrow('packageStorage requires a non-empty package id.')
})

test('package app runtime bridge raw storage methods only allow internal app buckets', async () => {
	const { bridge } = createPackageAppRuntimeBridgeForTest()
	const getValue = vi.fn(async () => ({ value: 'owned' }))
	const setValue = vi.fn(async () => ({ ok: true }))
	const getStorageRunner = vi
		.spyOn(
			bridge as unknown as {
				getStorageRunner: (storageId: string) => unknown
			},
			'getStorageRunner',
		)
		.mockImplementation(() => ({
			getValue,
			setValue,
			listValues: vi.fn(),
			sqlQuery: vi.fn(),
			deleteValue: vi.fn(),
			clearStorage: vi.fn(),
		}))
	vi.spyOn(
		bridge as unknown as {
			assertStorageWriteAllowed: (input: unknown) => Promise<void>
		},
		'assertStorageWriteAllowed',
	).mockResolvedValue(undefined)

	await expect(
		bridge.storageGet({
			storageId: 'package-1:facet:main',
			key: 'facet',
		}),
	).resolves.toEqual({ value: 'owned' })
	await expect(
		bridge.storageSet({
			storageId: 'package-1:Counter:instance-a',
			key: 'n',
			value: 1,
		}),
	).resolves.toEqual({ ok: true })
	expect(getStorageRunner).toHaveBeenCalledWith('package-1:facet:main')
	expect(getStorageRunner).toHaveBeenCalledWith('package-1:Counter:instance-a')

	const outsideNamespaceError =
		/outside this app's namespace[\s\S]*packageStorage\(\)/
	await expect(
		bridge.storageGet({ storageId: 'package-1', key: 'legacy-root' }),
	).rejects.toThrow(outsideNamespaceError)
	await expect(
		bridge.storageGet({
			storageId: buildPackageStorageId('victim-package'),
			key: 'secret',
		}),
	).rejects.toThrow(outsideNamespaceError)
	await expect(
		bridge.storageSet({
			storageId: 'job:nightly',
			key: 'state',
			value: true,
		}),
	).rejects.toThrow(outsideNamespaceError)
	await expect(
		bridge.storageGet({ storageId: 'other-package', key: 'x' }),
	).rejects.toThrow(outsideNamespaceError)
	await expect(
		bridge.storageGet({ storageId: '   ', key: 'x' }),
	).rejects.toThrow('Package app storage requires a non-empty storage id.')
	expect(getStorageRunner).toHaveBeenCalledTimes(3)
})

test('buildPackageAppWorker passes packageStorage grant ids from root, static, and dynamic deps', async () => {
	resetPackageAppRuntimeMocks()
	const { env } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		{
			row: {
				id: 'artifact-row-1',
				artifactName: null,
				entryPoint: 'app.js',
			},
			artifact: {
				mainModule: 'dist/app.js',
				modules: {
					'dist/app.js':
						'export default { fetch() { return new Response("cached") } }',
				},
				dependencies: [
					{
						sourceId: 'dep-source',
						publishedCommit: 'dep-commit',
						kodyId: 'dep',
						packageId: 'static-dep-package',
					},
				],
				dynamicDependencies: [
					{
						specifier: 'kody:@scope/dynamic/default',
						packageName: '@scope/dynamic',
						exportName: 'default',
					},
				],
			},
		},
	)
	packageAppRuntimeMock.hydrateKodyRuntimeModules.mockImplementation(
		async ({ modules }: { modules: Record<string, string> }) => ({
			modules,
			dynamicDependencyPackageIds: ['dynamic-dep-package'],
		}),
	)

	await buildPackageAppWorker({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-grants',
		savedPackage: {
			id: 'root-package',
			kodyId: 'example-grants',
			name: '@kody/example-grants',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
		},
		source: createPackageAppTestSource(),
		manifest: createPackageAppTestManifest(),
		runtime: {
			callerContext: {
				user: {
					userId: 'user-grants',
					email: 'grants@example.com',
					displayName: 'Grants User',
				},
			},
		} as never,
	})

	expect(packageAppRuntimeMock.packageAppRuntimeBridge).toHaveBeenCalledWith({
		props: expect.objectContaining({
			packageId: 'root-package',
			packageStorageGrantIds: expect.arrayContaining([
				'root-package',
				'static-dep-package',
				'dynamic-dep-package',
			]),
		}),
	})
	const bridgeProps = packageAppRuntimeMock.packageAppRuntimeBridge.mock
		.calls[0]?.[0] as {
		props: { packageStorageGrantIds: Array<string> }
	}
	expect(bridgeProps.props.packageStorageGrantIds).toHaveLength(3)
})
