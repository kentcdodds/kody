import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createBundleResult,
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

const { buildKodyAppBundle, hydrateKodyRuntimeModules } =
	await import('./module-graph.ts')

test('buildKodyModuleBundle keeps static imports pinned and rewrites literal dynamic imports to teaching errors', async () => {
	mockModule.createWorker.mockImplementation(
		async (input: { files: Record<string, string>; entryPoint: string }) => ({
			mainModule: input.entryPoint,
			modules: input.files,
			dependencies: [],
		}),
	)
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
			'value.js': 'export default function value() { return "source" }',
		},
	})
	let packageVersion = 'pinned'
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { userId: string; kind: string; artifactName?: string }) => {
			if (input.kind !== 'importable-module') return null
			return {
				row: {},
				artifact: {
					version: 1,
					kind: 'importable-module',
					artifactName: input.artifactName ?? './value',
					sourceId: 'source-1',
					publishedCommit:
						packageVersion === 'pinned' ? 'commit-pinned' : 'commit-current',
					entryPoint: './value.js',
					mainModule: 'value.js',
					modules: {
						'value.js': `export const marker = ${JSON.stringify(packageVersion)}
export default function value() { return ${JSON.stringify(packageVersion)} }`,
					},
					dependencies: [],
					dynamicDependencies: [],
					packageContext: null,
					createdAt: '2026-05-11T00:00:00.000Z',
				},
			}
		},
	)

	const { buildKodyModuleBundle } = await import('./module-graph.ts')
	const bundle = await buildKodyModuleBundle({
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
					dependencies: ['@kentcdodds/example-package'],
				},
			}),
			'index.js': `import staticValue from 'kody:@kentcdodds/example-package/value'

export default async function run() {
	const dynamicModule = await import('kody:@kentcdodds/example-package/value')
	return {
		staticValue: staticValue(),
		dynamicValue: dynamicModule.default(),
		dynamicMarker: dynamicModule.marker,
	}
}
`,
		},
		entryPoint: 'index.js',
	})

	expect(bundle.dependencies).toEqual([
		{
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			kodyId: 'example-package',
			packageName: '@kentcdodds/example-package',
			packageId: 'pkg-1',
		},
	])
	// Unsupported literal dynamic kody imports produce no placeholder modules
	// or dynamic-dependency metadata; the call site becomes a teaching error.
	expect(bundle.dynamicDependencies ?? []).toEqual([])
	packageVersion = 'current'
	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		modules: bundle.modules,
	})
	const moduleGraph = await createTemporaryModuleGraph(hydratedModules)
	try {
		const entry = (await moduleGraph.importModule(bundle.mainModule)) as {
			default: () => Promise<unknown>
		}
		await expect(entry.default()).rejects.toThrow(
			'Dynamic import("kody:@kentcdodds/example-package/value") was removed: use a static import',
		)
	} finally {
		await moduleGraph.cleanup()
	}
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			userId: 'user-1',
			name: '@kentcdodds/example-package',
		}),
	)
})

test('buildKodyModuleBundle rejects computed dynamic kody package imports clearly at runtime', async () => {
	mockModule.createWorker.mockImplementation(
		async (input: { files: Record<string, string>; entryPoint: string }) => ({
			mainModule: input.entryPoint,
			modules: input.files,
			dependencies: [],
		}),
	)

	const { buildKodyModuleBundle } = await import('./module-graph.ts')
	const bundle = await buildKodyModuleBundle({
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
			'index.js': `const specifier = 'kody:@kentcdodds/example-package/value'

export default async function run() {
	return await import(specifier)
}
`,
		},
		entryPoint: 'index.js',
	})
	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		modules: bundle.modules,
	})
	const moduleGraph = await createTemporaryModuleGraph(hydratedModules)
	try {
		const entry = (await moduleGraph.importModule(bundle.mainModule)) as {
			default: () => Promise<unknown>
		}
		await expect(entry.default()).rejects.toThrow(
			'Dynamic kody:@ package import requires an authenticated runtime',
		)
	} finally {
		await moduleGraph.cleanup()
	}
})

test('hydrateKodyRuntimeModules terminates circular literal dynamic package imports', async () => {
	const createDynamicPlaceholder = (specifier: string) =>
		`export const __kodyDynamicPackageSpecifier = ${JSON.stringify(specifier)};
throw new Error('unhydrated ${specifier}');
`
	const createLoadedPackage = (input: {
		name: string
		kodyId: string
		sourceId: string
		commit: string
	}) => ({
		source: {
			id: input.sourceId,
			published_commit: input.commit,
		},
		manifest: {
			name: input.name,
			exports: {
				'./run': './index.js',
			},
			kody: {
				id: input.kodyId,
				description: `${input.name} package`,
			},
		},
		files: {
			'index.js': 'export default async function run() { return "ok" }',
		},
	})
	const createArtifact = (input: {
		sourceId: string
		commit: string
		specifier: string
		nextSpecifier: string
	}) => ({
		version: 1,
		kind: 'importable-module' as const,
		artifactName: './run',
		sourceId: input.sourceId,
		publishedCommit: input.commit,
		entryPoint: './index.js',
		mainModule: 'index.js',
		modules: {
			'index.js': `export default async function run() {
	const module = await import('./.__kody_virtual__/dynamic-imports/next.js')
	return module.default
}
`,
			'.__kody_virtual__/dynamic-imports/next.js': createDynamicPlaceholder(
				input.nextSpecifier,
			),
		},
		dependencies: [],
		dynamicDependencies: [
			{
				specifier: input.nextSpecifier,
				packageName: input.nextSpecifier
					.replace('capabilities:', '')
					.split('/')
					.slice(0, 2)
					.join('/'),
				exportName: './run',
			},
		],
		packageContext: null,
		createdAt: '2026-05-11T00:00:00.000Z',
	})
	const packages = new Map([
		[
			'@kentcdodds/a-package',
			{
				row: createSavedPackageRecord({
					name: '@kentcdodds/a-package',
					kodyId: 'a-package',
					sourceId: 'source-a',
				}),
				loaded: createLoadedPackage({
					name: '@kentcdodds/a-package',
					kodyId: 'a-package',
					sourceId: 'source-a',
					commit: 'commit-a',
				}),
				artifact: createArtifact({
					sourceId: 'source-a',
					commit: 'commit-a',
					specifier: 'kody:@kentcdodds/a-package/run',
					nextSpecifier: 'kody:@kentcdodds/b-package/run',
				}),
			},
		],
		[
			'@kentcdodds/b-package',
			{
				row: createSavedPackageRecord({
					name: '@kentcdodds/b-package',
					kodyId: 'b-package',
					sourceId: 'source-b',
				}),
				loaded: createLoadedPackage({
					name: '@kentcdodds/b-package',
					kodyId: 'b-package',
					sourceId: 'source-b',
					commit: 'commit-b',
				}),
				artifact: createArtifact({
					sourceId: 'source-b',
					commit: 'commit-b',
					specifier: 'kody:@kentcdodds/b-package/run',
					nextSpecifier: 'kody:@kentcdodds/a-package/run',
				}),
			},
		],
	])
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) =>
			packages.get(input.name)?.row ?? null,
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) =>
			[...packages.values()].find(
				(entry) => entry.row.sourceId === input.sourceId,
			)?.loaded ?? null,
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { sourceId: string }) => ({
			row: {},
			artifact: [...packages.values()].find(
				(entry) => entry.row.sourceId === input.sourceId,
			)?.artifact,
		}),
	)

	const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		modules: {
			'entry.js': `export default async function run() {
	const module = await import('./.__kody_virtual__/dynamic-imports/a.js')
	return module.default
}
`,
			'.__kody_virtual__/dynamic-imports/a.js': createDynamicPlaceholder(
				'kody:@kentcdodds/a-package/run',
			),
		},
	})

	const currentArtifactModulePaths = Object.keys(hydratedModules).filter(
		(path) => path.includes('/.__kody_current__/'),
	)
	expect(currentArtifactModulePaths).toHaveLength(4)
	expect(
		currentArtifactModulePaths.filter((path) =>
			path.includes('/.__kody_current__/'),
		),
	).toEqual(currentArtifactModulePaths)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(2)
})

test('buildKodyModuleBundle rejects nested dynamic kody package import rewrites clearly', async () => {
	const { buildKodyModuleBundle } = await import('./module-graph.ts')

	await expect(
		buildKodyModuleBundle({
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
				'index.js': `export default async function run() {
	return await import(String(await import('kody:@kentcdodds/example-package/value')))
}
`,
			},
			entryPoint: 'index.js',
		}),
	).rejects.toThrow('Nested dynamic import expressions involving Kody package')
})

test.each([
	{
		name: 'export secret list',
		entryPoint: 'src/launch-agent.ts',
		source: `import { kody } from 'kody:runtime'

export default async function launchAgent() {
	return await kody.secretList({ scope: 'user' })
}
`,
		kody: {
			async secretList(input: unknown) {
				return { ok: true, tool: 'secretList', input }
			},
		},
		expected: {
			ok: true,
			tool: 'secretList',
			input: { scope: 'user' },
		},
	},
	{
		name: 'export package invocation token list',
		entryPoint: 'src/launch-agent.ts',
		source: `import { kody } from 'kody:runtime'

export default async function launchAgent() {
	return await kody.packageInvocationTokenList({})
}
`,
		kody: {
			async packageInvocationTokenList(input: unknown) {
				return { ok: true, tool: 'packageInvocationTokenList', input }
			},
		},
		expected: {
			ok: true,
			tool: 'packageInvocationTokenList',
			input: {},
		},
	},
])(
	'buildKodyModuleBundle keeps kody available for a preloaded package $name runtime',
	async ({ entryPoint, source, kody, expected }) => {
		mockModule.createWorker.mockImplementation(
			async (input: { files: Record<string, string>; entryPoint: string }) => ({
				mainModule: input.entryPoint,
				modules: input.files,
				dependencies: [],
			}),
		)

		const { buildKodyModuleBundle } = await import('./module-graph.ts')
		const bundle = await buildKodyModuleBundle({
			env: {
				APP_DB: {},
				REPO_SESSION: {},
			} as Env,
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kentcdodds/email-received-subscriber',
					exports: {
						'./launch-agent': './src/launch-agent.ts',
					},
					kody: {
						id: 'email-received-subscriber',
						description: 'Email received subscriber',
						subscriptions: {
							'email.message.received': {
								handler: './src/handle-email-message-received.ts',
							},
						},
					},
				}),
				[entryPoint]: source,
			},
			entryPoint,
		})

		expect(bundle.modules).not.toHaveProperty('.__kody_virtual__/runtime.js')
		const { modules: hydratedModules } = await hydrateKodyRuntimeModules({
			env: {
				APP_DB: {},
				REPO_SESSION: {},
			} as Env,
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			modules: bundle.modules,
		})
		const moduleGraph = await createTemporaryModuleGraph(hydratedModules)
		try {
			// Keep both imports on the same Node ESM cache entry to reproduce a
			// preloaded runtime module shared with the bundled entry.
			const runtime = (await moduleGraph.importModule(
				'.__kody_virtual__/runtime.js',
				{ cacheBust: false },
			)) as RuntimeModule
			const result = await runtime.__kodyRunInRuntime({ kody }, async () => {
				const entry = (await moduleGraph.importModule(bundle.mainModule, {
					cacheBust: false,
				})) as { default: (input?: unknown) => Promise<unknown> }
				return await entry.default({})
			})

			expect(result).toEqual(expected)
		} finally {
			await moduleGraph.cleanup()
		}
	},
)

test('buildKodyModuleBundle keeps virtual package paths distinct for scoped packages with the same leaf', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('shared-leaf-prefix'),
	)
	mockModule.getSavedPackageByName.mockImplementation(
		async (
			_db: unknown,
			input: {
				name: string
			},
		) => {
			if (input.name === '@alice/shared-package') {
				return createSavedPackageRecord({
					name: '@alice/shared-package',
					kodyId: 'shared-package',
					sourceId: 'source-alice',
				})
			}
			if (input.name === '@bob/shared-package') {
				return createSavedPackageRecord({
					name: '@bob/shared-package',
					kodyId: 'shared-package',
					sourceId: 'source-bob',
				})
			}
			return null
		},
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const sourceName =
				input.sourceId === 'source-alice'
					? '@alice/shared-package'
					: '@bob/shared-package'
			return {
				source: {
					id: input.sourceId,
					published_commit: `commit-${input.sourceId}`,
				},
				manifest: {
					name: sourceName,
					exports: {
						'.': './index.js',
						'./follow-up-on-pr-agent': './follow-up-on-pr-agent.js',
					},
					kody: {
						id: 'shared-package',
						description: `${sourceName} package`,
					},
				},
				files: {
					'index.js': `export const source = ${JSON.stringify(sourceName)}`,
					'follow-up-on-pr-agent.js': `export default ${JSON.stringify(sourceName)}`,
				},
			}
		},
	)

	const { buildKodyModuleBundle } = await import('./module-graph.ts')

	await buildKodyModuleBundle({
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
				'import aliceFn from "kody:@alice/shared-package/follow-up-on-pr-agent"',
				'import bobFn from "kody:@bob/shared-package/follow-up-on-pr-agent"',
				'export default [aliceFn, bobFn]',
			].join('\n'),
		},
		entryPoint: 'index.js',
	})

	const firstCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	expect(firstCall?.files).toMatchObject({
		'.__kody_packages__/@alice/shared-package/index.js':
			'export const source = "@alice/shared-package"',
		'.__kody_packages__/@bob/shared-package/index.js':
			'export const source = "@bob/shared-package"',
	})
})

test('buildKodyModuleBundle rejects kody id shorthand imports', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('kody-id-import'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(null)

	const { buildKodyModuleBundle } = await import('./module-graph.ts')

	await expect(
		buildKodyModuleBundle({
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
				'index.js':
					'import followUp from "kody:@example-package/follow-up-on-pr-agent"\nexport default followUp\n',
			},
			entryPoint: 'index.js',
		}),
	).rejects.toThrow(
		'Saved package "@example-package/follow-up-on-pr-agent" was not found for this user.',
	)

	expect(mockModule.getSavedPackageByName).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			name: '@example-package/follow-up-on-pr-agent',
		},
	)
	expect(mockModule.getSavedPackageByKodyId).not.toHaveBeenCalled()
})

test('buildKodyModuleBundle rejects ad-hoc execute imports of platform scopes', async () => {
	mockModule.getPlatformAccountByUsername.mockImplementation(
		async (_db: unknown, username: unknown) =>
			username === 'kody'
				? {
						id: 1,
						username: 'kody',
						email: 'kody@example.com',
						stableUserId: 'platform-kody',
					}
				: null,
	)
	mockModule.getSavedPackageByName.mockResolvedValue(null)

	try {
		const { buildKodyModuleBundle } = await import('./module-graph.ts')
		const { personPackagePlatformDependencyMessage } =
			await import('#worker/package-registry/platform-package-policy.ts')

		await expect(
			buildKodyModuleBundle({
				env: {
					APP_DB: {},
					REPO_SESSION: {},
				} as Env,
				baseUrl: 'https://heykody.dev',
				userId: 'user-1',
				sourceFiles: {
					'index.js':
						'import github from "kody:@kody/github"\nexport default github\n',
				},
				entryPoint: 'index.js',
				bundleContext: 'ad-hoc-execute',
			}),
		).rejects.toThrow(personPackagePlatformDependencyMessage)
	} finally {
		mockModule.getPlatformAccountByUsername.mockResolvedValue(null)
	}
})

test('buildKodyModuleBundle rejects person-package imports of platform scopes', async () => {
	mockModule.getPlatformAccountByUsername.mockImplementation(
		async (_db: unknown, username: unknown) =>
			username === 'kody'
				? {
						id: 1,
						username: 'kody',
						email: 'kody@example.com',
						stableUserId: 'platform-kody',
					}
				: null,
	)
	mockModule.getSavedPackageByName.mockResolvedValue(null)

	try {
		const { buildKodyModuleBundle } = await import('./module-graph.ts')
		const { personPackagePlatformDependencyMessage } =
			await import('#worker/package-registry/platform-package-policy.ts')

		await expect(
			buildKodyModuleBundle({
				env: {
					APP_DB: {},
					REPO_SESSION: {},
				} as Env,
				baseUrl: 'https://heykody.dev',
				userId: 'user-1',
				sourceFiles: {
					'package.json': JSON.stringify({
						name: '@alice/local-package',
						exports: {
							'.': './index.js',
						},
						kody: {
							id: 'local-package',
							description: 'Local package',
						},
					}),
					'index.js':
						'import github from "kody:@kody/github"\nexport default github\n',
				},
				entryPoint: 'index.js',
			}),
		).rejects.toThrow(personPackagePlatformDependencyMessage)
	} finally {
		mockModule.getPlatformAccountByUsername.mockResolvedValue(null)
	}
})

test('buildKodyAppBundle rewrites static and dynamic kody runtime imports inside TypeScript package apps', async () => {
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue(createBundleResult('ts-app'))

	await buildKodyAppBundle({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceFiles: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
					app: {
						entry: 'app.ts',
					},
				},
			}),
			'app.ts': `import { kody } from 'kody:runtime'

type CapabilityRecord = {
	name: string
}

export default {
	async fetch() {
		const result: Array<CapabilityRecord> =
			await kody.metaListCapabilities({})
		return Response.json({ count: result.length })
	},
}
`,
			'index.ts': 'export const value = "ok"',
		},
		entryPoint: 'app.ts',
		cacheKey: null,
	})

	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	const staticRewriteCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	expect(staticRewriteCall?.files?.['.__kody_root__/app.ts']).toContain(
		'../.__kody_virtual__/runtime.js',
	)
	expect(staticRewriteCall?.files?.['.__kody_root__/app.ts']).not.toContain(
		"'kody:runtime'",
	)

	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('ts-dynamic-app'),
	)
	await buildKodyAppBundle({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceFiles: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
					app: {
						entry: 'app.ts',
					},
				},
			}),
			'app.ts': `export default {
	async fetch() {
		const runtime = await import('kody:runtime')
		return Response.json({ hasCapabilities: typeof runtime.kody === 'object' })
	},
}
`,
			'index.ts': 'export const value = "ok"',
		},
		entryPoint: 'app.ts',
		cacheKey: null,
	})

	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	const dynamicRewriteCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	expect(dynamicRewriteCall?.files?.['.__kody_root__/app.ts']).toContain(
		'import("../.__kody_virtual__/runtime.js")',
	)
	expect(dynamicRewriteCall?.files?.['.__kody_root__/app.ts']).not.toContain(
		"import('kody:runtime')",
	)
})
