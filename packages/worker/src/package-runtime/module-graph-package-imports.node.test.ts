import { expect, test, vi } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createBundleResult,
	createTemporaryModuleGraph,
	createSavedPackageRecord,
	createLoadedPackageSource,
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

test('buildKodyModuleBundle resolves scoped package imports by full package name first', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('scoped-import'))
	mockModule.getSavedPackageByName.mockResolvedValue(
		createSavedPackageRecord({
			name: '@kentcdodds/example-package',
			kodyId: 'example-package',
		}),
	)
	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		createLoadedPackageSource(),
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
			'index.js':
				'import followUp from "kody:@kentcdodds/example-package/follow-up-on-pr-agent"\nexport default followUp\n',
		},
		entryPoint: 'index.js',
	})

	expect(mockModule.getSavedPackageByName).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			name: '@kentcdodds/example-package',
		},
	)
	expect(mockModule.getSavedPackageByKodyId).not.toHaveBeenCalled()
	const firstCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	expect(firstCall?.files?.['.__kody_root__/index.js']).toContain(
		'__kody_virtual__/imports/',
	)
	expect(firstCall?.files?.['.__kody_root__/index.js']).not.toContain(
		'kody:@kentcdodds/example-package/follow-up-on-pr-agent',
	)
})

test('buildKodyModuleBundle proxies package module default and named exports', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('named-import'))
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		...createLoadedPackageSource(),
		manifest: {
			name: '@kentcdodds/example-package',
			exports: {
				'./math': './math.js',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		},
		files: {
			'math.js':
				'export default function multiply(left, right) { return left * right }\nexport function add(left, right) { return left + right }',
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
				'import multiply, { add } from "kody:@kentcdodds/example-package/math"',
				'export default () => multiply(2, 3) + add(1, 2)',
			].join('\n'),
		},
		entryPoint: 'index.js',
	})

	const firstCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	const proxy = Object.entries(firstCall?.files ?? {}).find(([path]) =>
		path.includes('__kody_virtual__/imports/'),
	)?.[1]
	expect(proxy).toContain('export * from')
	expect(proxy).toContain('import * as __kodyPackageModule')
	// Static import proxies stamp the callee package id and wrap function
	// valued exports in the call-metering runtime helper.
	expect(proxy).toContain(
		'export default __kodyMeterStaticPackageExport("pkg-1", __kodyPackageModule.default)',
	)
	expect(proxy).toContain(
		'const __kodyMeteredStaticExport0 = __kodyMeterStaticPackageExport("pkg-1", __kodyPackageModule.add);',
	)
	expect(proxy).toContain('export { __kodyMeteredStaticExport0 as add };')
})

test('buildKodyModuleBundle imports callable entrypoints as ESM default exports', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('default-only'))
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
			'index.js': 'export default async () => ({ ok: true })',
		},
		entryPoint: 'index.js',
	})

	const firstCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	expect(
		firstCall?.files?.['.__kody_root__/.__kody_execute_entry__.js'],
	).toContain('import userEntrypoint from "./index.js"')
	expect(
		firstCall?.files?.['.__kody_root__/.__kody_execute_entry__.js'],
	).not.toContain('?? userModule')
})

test('buildKodyModuleBundle prefers published importable export artifacts for saved package imports', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('published-artifact'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@kentcdodds/example-package',
			exports: {
				'./html': './src/html.ts',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'./html': './src/html.ts',
				},
				dependencies: {
					marked: '18.0.2',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
				},
			}),
			'src/html.ts':
				'import { marked } from "marked"\nexport default async function render() { return marked.parse("**ok**") }',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { kind: string }) =>
			input.kind === 'importable-module'
				? {
						row: {
							id: 'artifact-1',
						},
						artifact: {
							version: 1,
							kind: 'importable-module',
							artifactName: './html',
							sourceId: 'source-1',
							publishedCommit: 'commit-1',
							entryPoint: 'src/html.ts',
							mainModule: 'dist/html.js',
							modules: {
								'dist/html.js':
									'export const helper = "ok"; export default async function render(input) { return input }',
							},
							dependencies: [
								{
									sourceId: 'source-1',
									publishedCommit: 'commit-1',
									kodyId: 'example-package',
									packageName: '@kentcdodds/example-package',
								},
							],
							packageContext: {
								packageId: 'pkg-1',
								kodyId: 'example-package',
								sourceId: 'source-1',
							},
							createdAt: '2026-05-01T00:00:00.000Z',
						},
					}
				: null,
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
			'index.js':
				'import render from "kody:@kentcdodds/example-package/html"\nexport default render\n',
		},
		entryPoint: 'index.js',
	})

	expect(result.dependencies).toEqual([
		{
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			kodyId: 'example-package',
			packageName: '@kentcdodds/example-package',
			packageId: 'pkg-1',
		},
	])
	const firstCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	const artifactEntry = Object.entries(firstCall?.files ?? {}).find(
		([path]) =>
			path.includes('.__published_bundle__') && path.endsWith('/dist/html.js'),
	)
	expect(artifactEntry?.[1]).toContain('export const helper = "ok"')
	expect(artifactEntry?.[1]).toContain('return input')
	expect(artifactEntry?.[1]).not.toContain('__kodyRuntime')
	expect(mockModule.loadPublishedBundleArtifactByIdentity).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: 'importable-module',
			artifactName: './html',
			entryPoint: 'src/html.ts',
		}),
	)
	const proxyEntry = Object.entries(firstCall?.files ?? {}).find(([path]) =>
		path.includes('__kody_virtual__/imports/'),
	)
	expect(proxyEntry?.[1]).toContain('.__published_bundle__')
	expect(proxyEntry?.[1]).not.toContain('src/html.ts')
})

test('buildKodyModuleBundle imports published importable defaults as callable default exports', async () => {
	mockModule.createWorker.mockImplementation(
		async (input: { files: Record<string, string>; entryPoint: string }) => ({
			mainModule: input.entryPoint,
			modules: input.files,
			dependencies: [],
		}),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@kentcdodds/example-package',
			exports: {
				'./callable': './src/callable.js',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'./callable': './src/callable.js',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
				},
			}),
			'src/callable.js': [
				'export const marker = "provider"',
				'export default function callable(input = {}) {',
				'\treturn { ok: true, value: input.value }',
				'}',
			].join('\n'),
		},
	})

	const { buildKodyImportableModuleBundle, buildKodyModuleBundle } =
		await import('./module-graph.ts')
	const importableBundle = await buildKodyImportableModuleBundle({
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
					'./callable': './src/callable.js',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
				},
			}),
			'src/callable.js': [
				'export const marker = "provider"',
				'export default function callable(input = {}) {',
				'\treturn { ok: true, value: input.value }',
				'}',
			].join('\n'),
		},
		entryPoint: 'src/callable.js',
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { kind: string }) =>
			input.kind === 'importable-module'
				? {
						row: {
							id: 'artifact-1',
						},
						artifact: {
							version: 1,
							kind: 'importable-module',
							artifactName: './callable',
							sourceId: 'source-1',
							publishedCommit: 'commit-1',
							entryPoint: 'src/callable.js',
							mainModule: importableBundle.mainModule,
							modules: importableBundle.modules,
							dependencies: [],
							packageContext: {
								packageId: 'pkg-1',
								kodyId: 'example-package',
								sourceId: 'source-1',
							},
							createdAt: '2026-05-01T00:00:00.000Z',
						},
					}
				: null,
	)

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
				'import callable from "kody:@kentcdodds/example-package/callable"',
				'export default callable',
			].join('\n'),
		},
		entryPoint: 'index.js',
	})

	const consumerCall = mockModule.createWorker.mock.calls.at(-1)?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	const proxyEntry = Object.entries(consumerCall?.files ?? {}).find(([path]) =>
		path.includes('__kody_virtual__/imports/'),
	)
	expect(proxyEntry).toBeDefined()
	const moduleGraph = await createTemporaryModuleGraph(
		consumerCall?.files ?? {},
	)
	try {
		const proxyModule = await moduleGraph.importModule(proxyEntry?.[0] ?? '')
		expect(proxyModule.marker).toBe('provider')
		expect(proxyModule.default({ value: 'from-published-artifact' })).toEqual({
			ok: true,
			value: 'from-published-artifact',
		})
	} finally {
		await moduleGraph.cleanup()
	}
})

test('buildKodyModuleBundle keeps distinct proxy and artifact paths for exports whose names only differ by punctuation', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('published-artifact-collision-safe'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@kentcdodds/example-package',
			exports: {
				'./foo.bar': './src/foo-dot.ts',
				'./foo-bar': './src/foo-dash.ts',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'./foo.bar': './src/foo-dot.ts',
					'./foo-bar': './src/foo-dash.ts',
				},
				dependencies: {
					marked: '18.0.2',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
				},
			}),
			'src/foo-dot.ts':
				'import { marked } from "marked"\nexport default async function fooDot() { return marked.parse("**dot**") }',
			'src/foo-dash.ts':
				'import { marked } from "marked"\nexport default async function fooDash() { return marked.parse("**dash**") }',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { artifactName?: string | null }) => {
			if (input.artifactName === './foo.bar') {
				return {
					row: {
						id: 'artifact-dot',
					},
					artifact: {
						version: 1,
						kind: 'module',
						artifactName: './foo.bar',
						sourceId: 'source-1',
						publishedCommit: 'commit-1',
						entryPoint: 'src/foo-dot.ts',
						mainModule: 'dist/foo-dot.js',
						modules: {
							'dist/foo-dot.js': 'export default "dot"',
						},
						dependencies: [],
						packageContext: {
							packageId: 'pkg-1',
							kodyId: 'example-package',
							sourceId: 'source-1',
						},
						createdAt: '2026-05-01T00:00:00.000Z',
					},
				}
			}
			if (input.artifactName === './foo-bar') {
				return {
					row: {
						id: 'artifact-dash',
					},
					artifact: {
						version: 1,
						kind: 'module',
						artifactName: './foo-bar',
						sourceId: 'source-1',
						publishedCommit: 'commit-1',
						entryPoint: 'src/foo-dash.ts',
						mainModule: 'dist/foo-dash.js',
						modules: {
							'dist/foo-dash.js': 'export default "dash"',
						},
						dependencies: [],
						packageContext: {
							packageId: 'pkg-1',
							kodyId: 'example-package',
							sourceId: 'source-1',
						},
						createdAt: '2026-05-01T00:00:00.000Z',
					},
				}
			}
			return null
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
				'import fooDot from "kody:@kentcdodds/example-package/foo.bar"',
				'import fooDash from "kody:@kentcdodds/example-package/foo-bar"',
				'export default [fooDot, fooDash]',
			].join('\n'),
		},
		entryPoint: 'index.js',
	})

	const firstCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	const publishedBundlePaths = Object.keys(firstCall?.files ?? {}).filter(
		(path) => path.includes('.__published_bundle__'),
	)
	expect(
		publishedBundlePaths.filter((path) => path.endsWith('/dist/foo-dot.js')),
	).toHaveLength(1)
	expect(
		publishedBundlePaths.filter((path) => path.endsWith('/dist/foo-dash.js')),
	).toHaveLength(1)
	expect(new Set(publishedBundlePaths).size).toBe(publishedBundlePaths.length)

	const proxyPaths = Object.keys(firstCall?.files ?? {}).filter((path) =>
		path.includes('__kody_virtual__/imports/'),
	)
	expect(proxyPaths).toHaveLength(2)
	expect(new Set(proxyPaths).size).toBe(2)
})

test('buildKodyModuleBundle requires a published artifact before importing saved package exports with npm dependencies', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('missing-artifact'),
	)
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@kentcdodds/example-package',
			exports: {
				'./html': './src/html.ts',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'./html': './src/html.ts',
				},
				dependencies: {
					marked: '18.0.2',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
				},
			}),
			'src/html.ts':
				'import { marked } from "marked"\nexport default async function render() { return marked.parse("**ok**") }',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

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
					'import render from "kody:@kentcdodds/example-package/html"\nexport default render\n',
			},
			entryPoint: 'index.js',
		}),
	).rejects.toThrow(
		'no published runtime bundle artifact is available yet. Republish the package so Kody can install dependencies and persist a fresh runtime bundle artifact.',
	)
})

test('buildKodyModuleBundle resolves transitive imports back to the root package source during rebuilds', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('root-cycle'))
	mockModule.getSavedPackageByName.mockResolvedValue(
		createSavedPackageRecord({
			name: '@kentcdodds/journaling',
			kodyId: 'journaling',
			sourceId: 'journaling-source',
		}),
	)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'journaling-source',
			published_commit: 'journaling-commit',
		},
		manifest: {
			name: '@kentcdodds/journaling',
			exports: {
				'./upsert-for-thread': './src/upsert-for-thread.ts',
			},
			kody: {
				id: 'journaling',
				description: 'Journaling package',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/journaling',
				exports: {
					'./upsert-for-thread': './src/upsert-for-thread.ts',
				},
				kody: {
					id: 'journaling',
					description: 'Journaling package',
				},
			}),
			'src/upsert-for-thread.ts':
				'import ensureState from "kody:@kentcdodds/personal-history/state-ensure"\nexport default ensureState\n',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

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
					name: '@kentcdodds/personal-history',
					exports: {
						'.': './src/index.ts',
						'./state-ensure': './src/state-ensure.ts',
					},
					dependencies: {
						jsonrepair: '3.13.1',
					},
					kody: {
						id: 'personal-history',
						description: 'Personal history package',
					},
				}),
				'src/index.ts':
					'import upsert from "kody:@kentcdodds/journaling/upsert-for-thread"\nexport default upsert\n',
				'src/state-ensure.ts':
					'export default async function ensureState() { return { ok: true } }\n',
			},
			entryPoint: 'src/index.ts',
		}),
	).resolves.toEqual({
		mainModule: 'dist/root-cycle.js',
		modules: {
			'dist/root-cycle.js':
				'export default { async fetch() { return new Response("root-cycle") } }',
		},
		dependencies: [
			{
				sourceId: 'journaling-source',
				publishedCommit: 'journaling-commit',
				kodyId: 'journaling',
				packageName: '@kentcdodds/journaling',
				packageId: 'pkg-1',
			},
		],
	})
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledTimes(1)
	expect(mockModule.getSavedPackageByName).toHaveBeenCalledWith(
		{},
		{ userId: 'user-1', name: '@kentcdodds/journaling' },
	)
})

test('buildKodyModuleBundle keeps dependencies for scoped packages with the same leaf', async () => {
	mockModule.createWorker.mockResolvedValue(createBundleResult('shared-leaf'))
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
		async (input: { sourceId: string }) => ({
			...createLoadedPackageSource(),
			source: {
				id: input.sourceId,
				published_commit: `commit-${input.sourceId}`,
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
				'import aliceFn from "kody:@alice/shared-package/follow-up-on-pr-agent"',
				'import bobFn from "kody:@bob/shared-package/follow-up-on-pr-agent"',
				'export default [aliceFn, bobFn]',
			].join('\n'),
		},
		entryPoint: 'index.js',
	})

	expect(result.dependencies).toEqual([
		{
			sourceId: 'source-alice',
			publishedCommit: 'commit-source-alice',
			kodyId: 'shared-package',
			packageName: '@alice/shared-package',
			packageId: 'pkg-1',
		},
		{
			sourceId: 'source-bob',
			publishedCommit: 'commit-source-bob',
			kodyId: 'shared-package',
			packageName: '@bob/shared-package',
			packageId: 'pkg-1',
		},
	])
})

test('buildKodyModuleBundle records only entrypoint-reachable kody package dependencies', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('reachable-deps'),
	)
	mockModule.getSavedPackageByName.mockImplementation(
		async (
			_db: unknown,
			input: {
				name: string
			},
		) => {
			if (input.name === '@alice/reachable-package') {
				return {
					id: 'pkg-reachable',
					userId: 'user-1',
					name: '@alice/reachable-package',
					kodyId: 'reachable-package',
					description: 'Reachable package',
					tags: [],
					searchText: null,
					sourceId: 'source-reachable',
					hasApp: false,
					hidden: false,
					isPrivate: false,
					createdAt: '2026-05-10T00:00:00.000Z',
					updatedAt: '2026-05-10T00:00:00.000Z',
				}
			}
			if (input.name === '@bob/unreachable-package') {
				return {
					id: 'pkg-unreachable',
					userId: 'user-1',
					name: '@bob/unreachable-package',
					kodyId: 'unreachable-package',
					description: 'Unreachable package',
					tags: [],
					searchText: null,
					sourceId: 'source-unreachable',
					hasApp: false,
					hidden: false,
					isPrivate: false,
					createdAt: '2026-05-10T00:00:00.000Z',
					updatedAt: '2026-05-10T00:00:00.000Z',
				}
			}
			return null
		},
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: {
				id: input.sourceId,
				user_id: 'user-1',
				entity_kind: 'package',
				entity_id: `pkg-${input.sourceId}`,
				repo_id: `repo-${input.sourceId}`,
				published_commit: `commit-${input.sourceId}`,
				indexed_commit: null,
				manifest_path: 'package.json',
				source_root: '/',
				last_external_check_at: null,
				external_check_until: null,
				created_at: '2026-05-10T00:00:00.000Z',
				updated_at: '2026-05-10T00:00:00.000Z',
			},
			manifest: {
				name:
					input.sourceId === 'source-reachable'
						? '@alice/reachable-package'
						: '@bob/unreachable-package',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id:
						input.sourceId === 'source-reachable'
							? 'reachable-package'
							: 'unreachable-package',
					description: 'Dependency package',
				},
			},
			files: {
				'package.json': '{}',
				'src/index.ts': 'export default async function run() { return "ok" }',
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
					'.': './src/index.ts',
					'./unused': './src/unused.ts',
				},
				kody: {
					id: 'local-package',
					description: 'Local package',
				},
			}),
			'src/index.ts':
				'import "./reachable.js"; export default async function run() { return "ok" }',
			'src/reachable.ts':
				'import reachable from "kody:@alice/reachable-package"; export { reachable }',
			'src/unused.ts':
				'import unreachable from "kody:@bob/unreachable-package"; export { unreachable }',
		},
		entryPoint: 'src/index.ts',
	})

	expect(result.dependencies).toEqual([
		{
			sourceId: 'source-reachable',
			publishedCommit: 'commit-source-reachable',
			kodyId: 'reachable-package',
			packageName: '@alice/reachable-package',
			packageId: 'pkg-reachable',
		},
	])
})

test('buildKodyModuleBundle follows self kody imports when recording reachable dependencies', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('self-reachable-deps'),
	)
	mockModule.getSavedPackageByName.mockImplementation(
		async (
			_db: unknown,
			input: {
				name: string
			},
		) => {
			if (input.name !== '@alice/reachable-package') return null
			return {
				id: 'pkg-reachable',
				userId: 'user-1',
				name: '@alice/reachable-package',
				kodyId: 'reachable-package',
				description: 'Reachable package',
				tags: [],
				searchText: null,
				sourceId: 'source-reachable',
				hasApp: false,
				hidden: false,
				isPrivate: false,
				createdAt: '2026-05-10T00:00:00.000Z',
				updatedAt: '2026-05-10T00:00:00.000Z',
			}
		},
	)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-reachable',
			user_id: 'user-1',
			entity_kind: 'package',
			entity_id: 'pkg-reachable',
			repo_id: 'repo-reachable',
			published_commit: 'commit-reachable',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			external_check_until: null,
			created_at: '2026-05-10T00:00:00.000Z',
			updated_at: '2026-05-10T00:00:00.000Z',
		},
		manifest: {
			name: '@alice/reachable-package',
			exports: {
				'.': './src/index.js',
			},
			kody: {
				id: 'reachable-package',
				description: 'Dependency package',
			},
		},
		files: {
			'package.json': '{}',
			'src/index.ts': 'export default async function run() { return "ok" }',
		},
	})

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
					'.': './src/index.ts',
					'./helper': './src/helper.js',
				},
				kody: {
					id: 'local-package',
					description: 'Local package',
				},
			}),
			'src/index.ts':
				'import helper from "kody:@kentcdodds/local-package/helper"; export default helper',
			'src/helper.ts':
				'import reachable from "kody:@alice/reachable-package"; export default reachable',
		},
		entryPoint: 'src/index.ts',
	})

	expect(result.dependencies).toEqual([
		{
			sourceId: 'source-reachable',
			publishedCommit: 'commit-reachable',
			kodyId: 'reachable-package',
			packageName: '@alice/reachable-package',
			packageId: 'pkg-reachable',
		},
	])
	const workerInput = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	const selfProxy = Object.values(workerInput?.files ?? {}).find((source) =>
		source.includes('src/helper.ts'),
	)
	expect(selfProxy).toContain('src/helper.ts')
	expect(Object.keys(workerInput?.files ?? {})).toContain(
		'.__kody_root__/src/helper.ts',
	)
	expect(Object.keys(workerInput?.files ?? {})).not.toContain(
		'.__kody_root__/src/helper.js',
	)
	expect(Object.keys(workerInput?.files ?? {})).toContain(
		'.__kody_packages__/@alice/reachable-package/src/index.ts',
	)
	expect(Object.keys(workerInput?.files ?? {})).not.toContain(
		'.__kody_packages__/@alice/reachable-package/src/index.js',
	)
})
