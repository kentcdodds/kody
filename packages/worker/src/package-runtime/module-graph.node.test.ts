import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createBundleResult,
	createBundleInput,
	createModuleBundleInput,
	createTemporaryModuleGraph,
	createSavedPackageRecord,
	createLoadedPackageSource,
	type RuntimeModule,
} from '#worker/test-support/module-graph.ts'

vi.mock('#worker/worker-bundler-modules.ts', () => ({
	importWorkerBundler: async () => ({
		createWorker: (...args: Array<unknown>) => mockModule.createWorker(...args),
	}),
}))

vi.mock('#worker/package-registry/scope-grants.ts', () => ({
	getPlatformAccountByUsername: (...args: Array<unknown>) =>
		mockModule.getPlatformAccountByUsername(...args),
	isPlatformAccountStableUserId: async () => false,
	listPlatformAccountUsernames: async () => [],
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactsModule>(
		'./published-bundle-artifacts.ts',
	)
	return {
		...actual,
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.loadPublishedBundleArtifactByIdentity(...args),
	}
})

const {
	buildKodyAppBundle,
	buildKodyModuleBundle,
	buildPackageRuntimeModulePath,
	createPackageRuntimeModuleSource,
	createPublishedPackageAppBundleCacheKey,
	createRuntimeModuleSource,
	hydrateKodyRuntimeModules,
	parsePackageRuntimeModulePathPackageId,
	refreshKodyRuntimeModules,
} = await import('./module-graph.ts')

test('hydrateKodyRuntimeModules resolves duplicate dynamic specifiers once per pass', async () => {
	const createDynamicPlaceholder = (specifier: string) =>
		`export const __kodyDynamicPackageSpecifier = ${JSON.stringify(specifier)};
throw new Error('unhydrated ${specifier}');
`
	const artifact = {
		version: 1,
		kind: 'importable-module' as const,
		artifactName: './value',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		entryPoint: './value.js',
		mainModule: 'value.js',
		modules: {
			'value.js': 'export default function value() { return "resolved" }',
		},
		dependencies: [],
		dynamicDependencies: [],
		packageContext: null,
		createdAt: '2026-05-11T00:00:00.000Z',
	}
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...createLoadedPackageSource(),
		manifest: {
			...createLoadedPackageSource().manifest,
			exports: {
				'./value': './value.js',
			},
		},
		files: {
			'value.js': 'export default function value() { return "resolved" }',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {},
		artifact,
	})

	const specifier = 'kody:@kentcdodds/example-package/value'
	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		modules: {
			'entry-a.js': `export default async function runA() {
	const module = await import('./.__kody_virtual__/dynamic-imports/a.js')
	return module.default
}
`,
			'entry-b.js': `export default async function runB() {
	const module = await import('./.__kody_virtual__/dynamic-imports/b.js')
	return module.default
}
`,
			'.__kody_virtual__/dynamic-imports/a.js':
				createDynamicPlaceholder(specifier),
			'.__kody_virtual__/dynamic-imports/b.js':
				createDynamicPlaceholder(specifier),
		},
	})

	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(1)
	expect(hydratedModules['.__kody_virtual__/dynamic-imports/a.js']).toContain(
		'__kodyDynamicPackageResolved',
	)
	expect(hydratedModules['.__kody_virtual__/dynamic-imports/b.js']).toContain(
		'__kodyDynamicPackageResolved',
	)
})

test('buildKodyModuleBundle keeps deterministic dependency ordering after parallel resolution', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('ordered-deps'))
	mockModule.getSavedPackageByName.mockImplementation(
		async (
			_db: unknown,
			input: {
				name: string
			},
		) => {
			if (input.name === '@kentcdodds/zebra-package') {
				return createSavedPackageRecord({
					name: '@kentcdodds/zebra-package',
					kodyId: 'zebra-package',
					sourceId: 'source-zebra',
				})
			}
			if (input.name === '@kentcdodds/alpha-package') {
				return createSavedPackageRecord({
					name: '@kentcdodds/alpha-package',
					kodyId: 'alpha-package',
					sourceId: 'source-alpha',
				})
			}
			return null
		},
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			...createLoadedPackageSource(),
			source: {
				id: input.sourceId,
				published_commit: `commit-${input.sourceId}`,
			},
			manifest: {
				name:
					input.sourceId === 'source-zebra'
						? '@kentcdodds/zebra-package'
						: '@kentcdodds/alpha-package',
				exports: {
					'.': './index.js',
				},
				kody: {
					id:
						input.sourceId === 'source-zebra'
							? 'zebra-package'
							: 'alpha-package',
					description: 'Dependency package',
				},
			},
			files: {
				'index.js': 'export default async function run() { return "ok" }',
			},
		}),
	)

	const { buildKodyModuleBundle } = await import('./module-graph.ts')

	const result = await buildKodyModuleBundle({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceFiles: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/local-package',
				exports: {
					'.': './index.js',
				},
				kody: {
					id: 'local-package',
					description: 'Local package',
				},
			}),
			'index.js': [
				'import zebra from "kody:@kentcdodds/zebra-package"',
				'import alpha from "kody:@kentcdodds/alpha-package"',
				'export default [zebra, alpha]',
			].join('\n'),
		},
		entryPoint: 'index.js',
	})

	expect(result.dependencies).toEqual([
		{
			sourceId: 'source-alpha',
			publishedCommit: 'commit-source-alpha',
			kodyId: 'alpha-package',
			packageName: '@kentcdodds/alpha-package',
			packageId: 'pkg-1',
		},
		{
			sourceId: 'source-zebra',
			publishedCommit: 'commit-source-zebra',
			kodyId: 'zebra-package',
			packageName: '@kentcdodds/zebra-package',
			packageId: 'pkg-1',
		},
	])
})

test('createRuntimeModuleSource returns a stable memoized string', () => {
	const first = createRuntimeModuleSource()
	const second = createRuntimeModuleSource()
	expect(first).toBe(second)
	expect(first).toContain('__kodyCreateRuntimeObjectProxy')
})

test('kody:runtime exports resolve against the current run when the module instance is reused across sequential runs', async () => {
	// Dynamic workers with identical code are cached and reused, so the
	// runtime module evaluates once and then serves every later run from the
	// isolate's ES module cache. Each run's `kody` closes over that run's RPC
	// dispatcher stubs, which are disposed when the run's evaluate() call
	// returns — a frozen `export const kody = runtime.kody` therefore made
	// every later run fail with "RPC stub used after being disposed".
	const modules = {
		'.__kody_virtual__/runtime.js': createRuntimeModuleSource(),
		'entry.js': [
			"import { kody, email } from './.__kody_virtual__/runtime.js'",
			'const capturedSearch = kody.community_search',
			'export default async function main() {',
			'\treturn {',
			"\t\tviaProxy: await kody.community_search({ query: 'slack' }),",
			"\t\tviaTopLevelCapture: await capturedSearch({ query: 'slack' }),",
			'\t\temail,',
			'\t}',
			'}',
		].join('\n'),
	}
	const moduleGraph = await createTemporaryModuleGraph(modules)
	try {
		const runtimeModule = (await moduleGraph.importModule(
			'.__kody_virtual__/runtime.js',
			{ cacheBust: false },
		)) as RuntimeModule
		const createRunRuntime = (label: string, state: { disposed: boolean }) => ({
			kody: {
				community_search: async (args: unknown) => {
					if (state.disposed) {
						throw new Error('RPC stub used after being disposed.')
					}
					return { label, args }
				},
			},
			email: null,
		})
		const runOnce = async (runtime: Record<string, unknown>) =>
			await runtimeModule.__kodyRunInRuntime(runtime, async () => {
				const entry = (await moduleGraph.importModule('entry.js', {
					cacheBust: false,
				})) as { default: () => Promise<unknown> }
				return await entry.default()
			})

		const firstState = { disposed: false }
		const first = await runOnce(createRunRuntime('first-run', firstState))
		expect(first).toEqual({
			viaProxy: { label: 'first-run', args: { query: 'slack' } },
			viaTopLevelCapture: { label: 'first-run', args: { query: 'slack' } },
			email: null,
		})

		// The first run's dispatcher stubs die once its evaluate() returns.
		firstState.disposed = true

		const second = await runOnce(
			createRunRuntime('second-run', { disposed: false }),
		)
		expect(second).toEqual({
			viaProxy: { label: 'second-run', args: { query: 'slack' } },
			viaTopLevelCapture: { label: 'second-run', args: { query: 'slack' } },
			email: null,
		})
	} finally {
		await moduleGraph.cleanup()
	}
})

test('buildKodyAppBundle cache lifecycle reuses hits, shares in-flight builds, evicts failures, and keys by entrypoint', async () => {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue(createBundleResult('warm-cache'))

	const cacheKey = createPublishedPackageAppBundleCacheKey({
		userId: 'user-1',
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
			manifest_path: 'package.json',
			source_root: '/',
		},
		entryPoint: 'app.js',
	})

	const first = await buildKodyAppBundle(createBundleInput({ cacheKey }))
	const second = await buildKodyAppBundle(createBundleInput({ cacheKey }))
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(first).toBe(second)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockResolvedValueOnce(createBundleResult('uncached-first'))
		.mockResolvedValueOnce(createBundleResult('uncached-second'))
	await buildKodyAppBundle(createBundleInput({ cacheKey: null }))
	await buildKodyAppBundle(createBundleInput({ cacheKey: null }))
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)

	mockModule.createWorker.mockReset()
	let resolveBundle:
		| ((value: { mainModule: string; modules: WorkerLoaderModules }) => void)
		| null = null
	const bundlePromise = new Promise<{
		mainModule: string
		modules: WorkerLoaderModules
	}>((resolve) => {
		resolveBundle = resolve
	})
	mockModule.createWorker.mockImplementation(async () => await bundlePromise)

	const concurrentCacheKey = createPublishedPackageAppBundleCacheKey({
		userId: 'user-1',
		source: {
			id: 'source-concurrent',
			published_commit: 'commit-concurrent-1',
			manifest_path: 'package.json',
			source_root: '/',
		},
		entryPoint: 'app.js',
	})
	const firstPromise = buildKodyAppBundle(
		createBundleInput({ cacheKey: concurrentCacheKey }),
	)
	const secondPromise = buildKodyAppBundle(
		createBundleInput({ cacheKey: concurrentCacheKey }),
	)
	resolveBundle?.(createBundleResult('shared-in-flight'))
	const [inFlightFirst, inFlightSecond] = await Promise.all([
		firstPromise,
		secondPromise,
	])
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(inFlightFirst).toBe(inFlightSecond)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockRejectedValueOnce(new Error('bundle failed'))
		.mockResolvedValueOnce(createBundleResult('retry-success'))
	const failureCacheKey = createPublishedPackageAppBundleCacheKey({
		userId: 'user-1',
		source: {
			id: 'source-failure',
			published_commit: 'commit-failure-1',
			manifest_path: 'package.json',
			source_root: '/',
		},
		entryPoint: 'app.js',
	})
	await expect(
		buildKodyAppBundle(createBundleInput({ cacheKey: failureCacheKey })),
	).rejects.toThrow('bundle failed')
	const retried = await buildKodyAppBundle(
		createBundleInput({ cacheKey: failureCacheKey }),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)
	expect(retried).toEqual(createBundleResult('retry-success'))

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockResolvedValueOnce(createBundleResult('entry-app'))
		.mockResolvedValueOnce(createBundleResult('entry-admin'))
	const source = {
		id: 'source-shared',
		published_commit: 'commit-shared-1',
		manifest_path: 'package.json',
		source_root: '/',
	}
	const appEntryCacheKey = createPublishedPackageAppBundleCacheKey({
		userId: 'user-1',
		source,
		entryPoint: 'app.js',
	})
	const adminEntryCacheKey = createPublishedPackageAppBundleCacheKey({
		userId: 'user-1',
		source,
		entryPoint: 'admin.js',
	})
	const appBundle = await buildKodyAppBundle(
		createBundleInput({ cacheKey: appEntryCacheKey, entryPoint: 'app.js' }),
	)
	const adminBundle = await buildKodyAppBundle(
		createBundleInput({
			cacheKey: adminEntryCacheKey,
			entryPoint: 'admin.js',
		}),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)
	expect(appBundle).not.toBe(adminBundle)
})

test('buildKodyModuleBundle cache lifecycle reuses hits, skips when disabled, keys by code and userId, and evicts failures', async () => {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue(createBundleResult('module-warm'))

	const first = await buildKodyModuleBundle(
		createModuleBundleInput({ reuseCachedBundle: true }),
	)
	const second = await buildKodyModuleBundle(
		createModuleBundleInput({ reuseCachedBundle: true }),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(first).toEqual(second)
	expect(first.modules).not.toBe(second.modules)
	expect(first.dependencies).not.toBe(second.dependencies)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockResolvedValueOnce(createBundleResult('module-uncached-first'))
		.mockResolvedValueOnce(createBundleResult('module-uncached-second'))
	await buildKodyModuleBundle(createModuleBundleInput())
	await buildKodyModuleBundle(
		createModuleBundleInput({ reuseCachedBundle: false }),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockResolvedValueOnce(createBundleResult('module-code-a'))
		.mockResolvedValueOnce(createBundleResult('module-code-b'))
	await buildKodyModuleBundle(
		createModuleBundleInput({
			reuseCachedBundle: true,
			code: 'export default async function run() { return "a" }',
		}),
	)
	await buildKodyModuleBundle(
		createModuleBundleInput({
			reuseCachedBundle: true,
			code: 'export default async function run() { return "b" }',
		}),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockResolvedValueOnce(createBundleResult('module-user-1'))
		.mockResolvedValueOnce(createBundleResult('module-user-2'))
	await buildKodyModuleBundle(
		createModuleBundleInput({
			reuseCachedBundle: true,
			userId: 'user-cache-a',
			code: 'export default async function run() { return "shared" }',
		}),
	)
	await buildKodyModuleBundle(
		createModuleBundleInput({
			reuseCachedBundle: true,
			userId: 'user-cache-b',
			code: 'export default async function run() { return "shared" }',
		}),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)

	mockModule.createWorker.mockReset()
	mockModule.createWorker
		.mockRejectedValueOnce(new Error('module bundle failed'))
		.mockResolvedValueOnce(createBundleResult('module-retry-success'))
	await expect(
		buildKodyModuleBundle(
			createModuleBundleInput({
				reuseCachedBundle: true,
				code: 'export default async function run() { return "retry" }',
			}),
		),
	).rejects.toThrow('module bundle failed')
	const retried = await buildKodyModuleBundle(
		createModuleBundleInput({
			reuseCachedBundle: true,
			code: 'export default async function run() { return "retry" }',
		}),
	)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)
	expect(retried).toEqual(createBundleResult('module-retry-success'))
})

test('hydrateKodyRuntimeModules replaces stale persisted kody runtime modules', async () => {
	const staleRuntimeSource =
		'export const kody = { stale: true }; export default { kody };'
	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		modules: {
			'.__kody_virtual__/runtime.js': staleRuntimeSource,
			'entry.js': `import { __kodyRunInRuntime, kody } from './.__kody_virtual__/runtime.js'

export async function runWithRuntime(runtime) {
	return await __kodyRunInRuntime(runtime, async () => kody.hostRuntimeVersion({}))
}
`,
		},
	})

	expect(hydratedModules['.__kody_virtual__/runtime.js']).not.toBe(
		staleRuntimeSource,
	)
	const moduleGraph = await createTemporaryModuleGraph(hydratedModules)
	try {
		const entry = (await moduleGraph.importModule('entry.js')) as {
			runWithRuntime: (runtime: Record<string, unknown>) => Promise<unknown>
		}
		const result = await entry.runWithRuntime({
			kody: {
				async hostRuntimeVersion() {
					return 'current-host-runtime'
				},
			},
		})
		expect(result).toBe('current-host-runtime')
	} finally {
		await moduleGraph.cleanup()
	}
})

test('hydrateKodyRuntimeModules fixes stale nested runtime modules from static package artifacts', async () => {
	const nestedRuntimePath =
		'.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e/.__kody_virtual__/runtime.js'
	const staleRuntimeSource = [
		'const runtime = {}',
		'export const kody = runtime.kody',
		'export default runtime',
	].join('\n')
	const modules = {
		'.__kody_virtual__/runtime.js': createRuntimeModuleSource(),
		'entry.js': [
			"import { __kodyRunInRuntime } from './.__kody_virtual__/runtime.js'",
			"import runDependency from './.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e/index.js'",
			'',
			'export async function runWithRuntime(runtime) {',
			'\treturn await __kodyRunInRuntime(runtime, async () => runDependency())',
			'}',
		].join('\n'),
		'.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e/index.js':
			[
				"import { kody } from './.__kody_virtual__/runtime.js'",
				'',
				'export default async function runDependency() {',
				'\treturn await kody.secret_list({ scope: "user" })',
				'}',
			].join('\n'),
		[nestedRuntimePath]: staleRuntimeSource,
	}
	const staleModuleGraph = await createTemporaryModuleGraph(modules)
	try {
		const staleEntry = (await staleModuleGraph.importModule('entry.js')) as {
			runWithRuntime: (runtime: Record<string, unknown>) => Promise<unknown>
		}
		await expect(
			staleEntry.runWithRuntime({
				kody: {
					async secret_list() {
						return { ok: true }
					},
				},
			}),
		).rejects.toThrow(
			"Cannot read properties of undefined (reading 'secret_list')",
		)
	} finally {
		await staleModuleGraph.cleanup()
	}

	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		modules,
	})
	expect(hydratedModules[nestedRuntimePath]).not.toBe(staleRuntimeSource)
	const hydratedModuleGraph = await createTemporaryModuleGraph(hydratedModules)
	try {
		const hydratedEntry = (await hydratedModuleGraph.importModule(
			'entry.js',
		)) as {
			runWithRuntime: (runtime: Record<string, unknown>) => Promise<unknown>
		}
		const result = await hydratedEntry.runWithRuntime({
			kody: {
				async secret_list(args: unknown) {
					return { ok: true, args }
				},
			},
		})
		expect(result).toEqual({
			ok: true,
			args: {
				scope: 'user',
			},
		})
	} finally {
		await hydratedModuleGraph.cleanup()
	}
})

test('buildKodyModuleBundle refreshes nested artifact runtimes before static import rebundling', async () => {
	const staleRuntimeSource = [
		'const runtime = {}',
		'export const kody = runtime.kody',
		'export default runtime',
	].join('\n')
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('ai-chat-caller'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(
		createSavedPackageRecord({
			name: '@kentcdodds/ai-chat',
			kodyId: 'ai-chat',
			sourceId: 'source-ai-chat',
		}),
	)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-ai-chat',
			published_commit: 'commit-ai-chat',
		},
		manifest: {
			name: '@kentcdodds/ai-chat',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'ai-chat',
				description: 'AI chat helpers',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/ai-chat',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'ai-chat',
					description: 'AI chat helpers',
				},
			}),
			'src/index.ts':
				'import { kody } from "kody:runtime"\nexport async function runAgentTurnNonStreaming() { return await kody.value_get({ name: "ai-chat" }) }',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {},
		artifact: {
			version: 1,
			kind: 'importable-module',
			artifactName: '.',
			sourceId: 'source-ai-chat',
			publishedCommit: 'commit-ai-chat',
			entryPoint: './src/index.ts',
			mainModule: 'dist/index.js',
			modules: {
				'dist/index.js': [
					"import { kody } from './.__kody_virtual__/runtime.js'",
					'export async function runAgentTurnNonStreaming() {',
					'\treturn await kody.value_get({ name: "ai-chat" })',
					'}',
				].join('\n'),
				'dist/.__kody_virtual__/runtime.js': staleRuntimeSource,
			},
			dependencies: [],
			dynamicDependencies: [],
			packageContext: {
				packageId: 'pkg-ai-chat',
				kodyId: 'ai-chat',
				sourceId: 'source-ai-chat',
			},
			createdAt: '2026-05-13T00:00:00.000Z',
		},
	})

	const { buildKodyModuleBundle } = await import('./module-graph.ts')
	await buildKodyModuleBundle({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceFiles: {
			'entry.ts': [
				"import { runAgentTurnNonStreaming } from 'kody:@kentcdodds/ai-chat'",
				'export default async function main() {',
				'\treturn await runAgentTurnNonStreaming()',
				'}',
			].join('\n'),
		},
		entryPoint: 'entry.ts',
	})

	const bundlerInput = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	const nestedRuntimePath =
		'.__kody_packages__/@kentcdodds/ai-chat/.__published_bundle__/2e/dist/.__kody_virtual__/runtime.js'
	expect(bundlerInput?.files?.[nestedRuntimePath]).toContain(
		'__kodyCreateRuntimeObjectProxy',
	)
	expect(bundlerInput?.files?.[nestedRuntimePath]).not.toBe(staleRuntimeSource)
})

test('package runtime module paths round-trip stamped package ids', () => {
	const packageId = crypto.randomUUID()
	const modulePath = buildPackageRuntimeModulePath(packageId)
	expect(modulePath).toMatch(
		/^\.__kody_virtual__\/package-runtime\/[0-9a-f]+\.js$/,
	)
	expect(parsePackageRuntimeModulePathPackageId(modulePath)).toBe(packageId)
	// Artifact installs nest the stamped module under graph prefixes; the id
	// must still parse out.
	expect(
		parsePackageRuntimeModulePathPackageId(
			`.__kody_packages__/@kentcdodds/example-package/.__published_bundle__/2e/${modulePath}`,
		),
	).toBe(packageId)
	expect(
		parsePackageRuntimeModulePathPackageId('.__kody_virtual__/runtime.js'),
	).toBeNull()
	expect(parsePackageRuntimeModulePathPackageId('src/index.js')).toBeNull()
	expect(
		parsePackageRuntimeModulePathPackageId(
			'.__kody_virtual__/package-runtime/not-hex.js',
		),
	).toBeNull()

	const moduleSource = createPackageRuntimeModuleSource(packageId)
	expect(moduleSource).toContain(JSON.stringify(packageId))
	expect(moduleSource).toContain('__kodyCreatePackageBoundStorage')
	expect(moduleSource).toContain('../runtime.js')
})

test('buildKodyModuleBundle stamps root modules with a per-package runtime module when rootPackageId is provided', async () => {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue(createBundleResult('stamped-root'))
	const rootPackageId = crypto.randomUUID()

	await buildKodyModuleBundle({
		...createModuleBundleInput({
			code: [
				"import { packageStorage } from 'kody:runtime'",
				'export default async function run() {',
				'\treturn packageStorage().id',
				'}',
			].join('\n'),
		}),
		rootPackageId,
	})

	const stampedCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| { files?: Record<string, string> }
		| undefined
	const stampedModulePath = buildPackageRuntimeModulePath(rootPackageId)
	expect(stampedCall?.files?.['.__kody_root__/entry.ts']).toContain(
		`../${stampedModulePath}`,
	)
	expect(stampedCall?.files?.['.__kody_root__/entry.ts']).not.toContain(
		"'kody:runtime'",
	)
	expect(stampedCall?.files?.[stampedModulePath]).toBe(
		createPackageRuntimeModuleSource(rootPackageId),
	)

	// Without root provenance the same source keeps the shared runtime module
	// (whose packageStorage falls back to the run's own package context).
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('unstamped-root'),
	)
	await buildKodyModuleBundle(
		createModuleBundleInput({
			code: [
				"import { packageStorage } from 'kody:runtime'",
				'export default async function run() {',
				'\treturn packageStorage().id',
				'}',
			].join('\n'),
		}),
	)
	const unstampedCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| { files?: Record<string, string> }
		| undefined
	expect(unstampedCall?.files?.['.__kody_root__/entry.ts']).toContain(
		'../.__kody_virtual__/runtime.js',
	)
	expect(unstampedCall?.files?.['.__kody_root__/entry.ts']).not.toContain(
		'package-runtime/',
	)
})

test('statically imported saved package sources get stamped with their own package id', async () => {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('stamped-dependency'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...createLoadedPackageSource(),
		files: {
			'index.js': 'export const value = "ok"',
			'follow-up-on-pr-agent.js': [
				"import { packageStorage } from 'kody:runtime'",
				'export default async function followUp() {',
				'\treturn packageStorage().id',
				'}',
			].join('\n'),
		},
	})

	await buildKodyModuleBundle(
		createModuleBundleInput({
			code: [
				"import followUp from 'kody:@kentcdodds/example-package/follow-up-on-pr-agent'",
				"import { packageStorage } from 'kody:runtime'",
				'export default async function run() {',
				'\treturn { dependency: await followUp(), root: packageStorage().id }',
				'}',
			].join('\n'),
		}),
	)

	const call = mockModule.createWorker.mock.calls[0]?.[0] as
		| { files?: Record<string, string> }
		| undefined
	// The dependency module (saved package id pkg-1) is stamped…
	const dependencyModulePath =
		'.__kody_packages__/@kentcdodds/example-package/follow-up-on-pr-agent.js'
	const stampedModulePath = buildPackageRuntimeModulePath('pkg-1')
	expect(call?.files?.[dependencyModulePath]).toContain(
		`../../../${stampedModulePath}`,
	)
	expect(call?.files?.[stampedModulePath]).toBe(
		createPackageRuntimeModuleSource('pkg-1'),
	)
	// …while the unprovenanced root entry keeps the shared runtime module.
	expect(call?.files?.['.__kody_root__/entry.ts']).toContain(
		'../.__kody_virtual__/runtime.js',
	)
	expect(call?.files?.['.__kody_root__/entry.ts']).not.toContain(
		'package-runtime/',
	)
})

test('refreshKodyRuntimeModules regenerates stale per-package runtime modules and their sibling shared runtime', () => {
	const packageId = crypto.randomUUID()
	const nestedPrefix =
		'.__kody_packages__/@kentcdodds/example-package/.__published_bundle__/2e'
	const stampedModulePath = `${nestedPrefix}/${buildPackageRuntimeModulePath(packageId)}`
	const refreshed = refreshKodyRuntimeModules({
		'entry.js': [
			`import { packageStorage } from './${stampedModulePath}'`,
			'export default async function run() {',
			'\treturn packageStorage().id',
			'}',
		].join('\n'),
		[stampedModulePath]: 'export const packageStorage = () => "stale"',
	})
	expect(refreshed[stampedModulePath]).toBe(
		createPackageRuntimeModuleSource(packageId),
	)
	// The regenerated stamped module imports its sibling shared runtime; the
	// refresh must materialize that sibling even when nothing referenced it.
	expect(refreshed[`${nestedPrefix}/.__kody_virtual__/runtime.js`]).toBe(
		createRuntimeModuleSource(),
	)
})

test('packageStorage resolves the stamped package id, falls back to the run package context, and rejects unprovenanced calls', async () => {
	const packageId = crypto.randomUUID()
	const stampedModulePath = buildPackageRuntimeModulePath(packageId)
	const moduleGraph = await createTemporaryModuleGraph({
		'.__kody_virtual__/runtime.js': createRuntimeModuleSource(),
		[stampedModulePath]: createPackageRuntimeModuleSource(packageId),
		'stamped-entry.js': [
			`import runtimeDefault, { packageStorage } from './${stampedModulePath}'`,
			'export default async function main() {',
			'\treturn {',
			'\t\tnamed: packageStorage().id,',
			'\t\tviaDefault: runtimeDefault.packageStorage().id,',
			'\t}',
			'}',
		].join('\n'),
		'unstamped-entry.js': [
			"import { packageStorage } from './.__kody_virtual__/runtime.js'",
			'export default async function main() {',
			'\treturn packageStorage().id',
			'}',
		].join('\n'),
	})
	try {
		const runtimeModule = (await moduleGraph.importModule(
			'.__kody_virtual__/runtime.js',
			{ cacheBust: false },
		)) as RuntimeModule
		const runEntry = async (
			entryPath: string,
			runtime: Record<string, unknown>,
		) =>
			await runtimeModule.__kodyRunInRuntime(runtime, async () => {
				const entry = (await moduleGraph.importModule(entryPath, {
					cacheBust: false,
				})) as { default: () => Promise<unknown> }
				return await entry.default()
			})
		const boundRuntime = {
			__kodyPackageStorage: (boundPackageId: string) => ({
				id: `package:${boundPackageId}`,
			}),
			packageContext: { packageId: 'pkg-context', kodyId: 'context' },
		}

		// Stamped modules use their bundle-time identity even when the run
		// belongs to a different package.
		await expect(runEntry('stamped-entry.js', boundRuntime)).resolves.toEqual({
			named: `package:${packageId}`,
			viaDefault: `package:${packageId}`,
		})
		// Unstamped modules fall back to the run's own package context.
		await expect(runEntry('unstamped-entry.js', boundRuntime)).resolves.toBe(
			'package:pkg-context',
		)
		// No provenance at all: a clear, actionable error.
		await expect(
			runEntry('unstamped-entry.js', {
				__kodyPackageStorage: boundRuntime.__kodyPackageStorage,
			}),
		).rejects.toThrow('packageStorage() requires package provenance')
		// Contexts that never bind the factory (no authenticated user) fail
		// with the availability message instead of a bare TypeError.
		await expect(
			runEntry('stamped-entry.js', { packageContext: null }),
		).rejects.toThrow('packageStorage() is not available')
	} finally {
		await moduleGraph.cleanup()
	}
})
