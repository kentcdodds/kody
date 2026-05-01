import { beforeEach, expect, test, vi } from 'vitest'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'

const mockModule = vi.hoisted(() => ({
	createWorker: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getSavedPackageByName: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
}))

vi.mock('@cloudflare/worker-bundler', () => ({
	createWorker: (...args: Array<unknown>) => mockModule.createWorker(...args),
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

const { buildKodyAppBundle, createPublishedPackageAppBundleCacheKey } =
	await import('./module-graph.ts')

beforeEach(() => {
	mockModule.createWorker.mockReset()
	mockModule.getSavedPackageByName.mockReset()
	mockModule.getSavedPackageByKodyId.mockReset()
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.loadPublishedBundleArtifactByIdentity.mockReset()
})

function createBundleResult(suffix: string) {
	return {
		mainModule: `dist/${suffix}.js`,
		modules: {
			[`dist/${suffix}.js`]: `export default { async fetch() { return new Response(${JSON.stringify(
				suffix,
			)}) } }`,
		} satisfies WorkerLoaderModules,
		dependencies: [],
	}
}

function createBundleInput(input?: {
	cacheKey?: string | null
	entryPoint?: string
}) {
	return {
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
					'.': './index.js',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
					app: {
						entry: input?.entryPoint ?? 'app.js',
					},
				},
			}),
			'app.js':
				'export default { async fetch() { return new Response("app") } }',
			'index.js': 'export const value = "ok"',
		},
		entryPoint: input?.entryPoint ?? 'app.js',
		cacheKey: input?.cacheKey,
	}
}

function createSavedPackageRecord(input?: {
	name?: string
	kodyId?: string
	sourceId?: string
}) {
	return {
		id: 'pkg-1',
		userId: 'user-1',
		name: input?.name ?? '@kentcdodds/example-package',
		kodyId: input?.kodyId ?? 'example-package',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: input?.sourceId ?? 'source-1',
		hasApp: false,
		createdAt: '2026-04-24T00:00:00.000Z',
		updatedAt: '2026-04-24T00:00:00.000Z',
	}
}

function createLoadedPackageSource() {
	return {
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@kentcdodds/example-package',
			exports: {
				'.': './index.js',
				'./follow-up-on-pr-agent': './follow-up-on-pr-agent.js',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		},
		files: {
			'index.js': 'export const value = "ok"',
			'follow-up-on-pr-agent.js':
				'export default async function followUp() { return "ok" }',
		},
	}
}

test('buildKodyAppBundle reuses cached published package app bundles', async () => {
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

	const first = await buildKodyAppBundle(
		createBundleInput({
			cacheKey,
		}),
	)
	const second = await buildKodyAppBundle(
		createBundleInput({
			cacheKey,
		}),
	)

	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(first).toBe(second)
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
	expect(proxy).toContain('export default __kodyPackageModule.default')
})

test('buildKodyModuleBundle prefers published export artifacts for saved package imports', async () => {
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
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {
			id: 'artifact-1',
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: './html',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/html.ts',
			mainModule: 'dist/html.js',
			modules: {
				'dist/html.js':
					'export default async function render() { return "<p><strong>ok</strong></p>" }',
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
			serviceContext: null,
			createdAt: '2026-05-01T00:00:00.000Z',
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
	expect(artifactEntry?.[1]).toContain('<p><strong>ok</strong></p>')
	const proxyEntry = Object.entries(firstCall?.files ?? {}).find(([path]) =>
		path.includes('__kody_virtual__/imports/'),
	)
	expect(proxyEntry?.[1]).toContain('.__published_bundle__')
	expect(proxyEntry?.[1]).not.toContain('src/html.ts')
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
						serviceContext: null,
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
						serviceContext: null,
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
		},
		{
			sourceId: 'source-bob',
			publishedCommit: 'commit-source-bob',
			kodyId: 'shared-package',
			packageName: '@bob/shared-package',
		},
	])
})

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

test('buildKodyAppBundle does not cache unpublished package app bundles', async () => {
	mockModule.createWorker
		.mockResolvedValueOnce(createBundleResult('uncached-first'))
		.mockResolvedValueOnce(createBundleResult('uncached-second'))

	await buildKodyAppBundle(
		createBundleInput({
			cacheKey: null,
		}),
	)
	await buildKodyAppBundle(
		createBundleInput({
			cacheKey: null,
		}),
	)

	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)
})

test('buildKodyAppBundle shares the same in-flight published bundle build', async () => {
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

	const cacheKey = createPublishedPackageAppBundleCacheKey({
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
		createBundleInput({
			cacheKey,
		}),
	)
	const secondPromise = buildKodyAppBundle(
		createBundleInput({
			cacheKey,
		}),
	)

	resolveBundle?.(createBundleResult('shared-in-flight'))

	const [first, second] = await Promise.all([firstPromise, secondPromise])

	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(first).toBe(second)
})

test('buildKodyAppBundle evicts rejected published bundle builds before retrying', async () => {
	mockModule.createWorker
		.mockRejectedValueOnce(new Error('bundle failed'))
		.mockResolvedValueOnce(createBundleResult('retry-success'))

	const cacheKey = createPublishedPackageAppBundleCacheKey({
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
		buildKodyAppBundle(
			createBundleInput({
				cacheKey,
			}),
		),
	).rejects.toThrow('bundle failed')

	const retried = await buildKodyAppBundle(
		createBundleInput({
			cacheKey,
		}),
	)

	expect(mockModule.createWorker).toHaveBeenCalledTimes(2)
	expect(retried).toEqual(createBundleResult('retry-success'))
})

test('buildKodyAppBundle keeps separate cache entries for different app entrypoints', async () => {
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
		createBundleInput({
			cacheKey: appEntryCacheKey,
			entryPoint: 'app.js',
		}),
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

test('buildKodyAppBundle rewrites kody runtime imports inside TypeScript package apps', async () => {
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
			'app.ts': `import { codemode } from 'kody:runtime'

type CapabilityRecord = {
	name: string
}

export default {
	async fetch() {
		const result: Array<CapabilityRecord> =
			await codemode.meta_list_capabilities({})
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
	const firstCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	expect(firstCall?.files?.['.__kody_root__/app.ts']).toContain(
		'../.__kody_virtual__/runtime.js',
	)
	expect(firstCall?.files?.['.__kody_root__/app.ts']).not.toContain(
		"'kody:runtime'",
	)
})

test('buildKodyAppBundle rewrites dynamic kody runtime imports inside TypeScript package apps', async () => {
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
		return Response.json({ hasCodemode: typeof runtime.codemode === 'object' })
	},
}
`,
			'index.ts': 'export const value = "ok"',
		},
		entryPoint: 'app.ts',
		cacheKey: null,
	})

	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	const firstCall = mockModule.createWorker.mock.calls[0]?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	expect(firstCall?.files?.['.__kody_root__/app.ts']).toContain(
		'import("../.__kody_virtual__/runtime.js")',
	)
	expect(firstCall?.files?.['.__kody_root__/app.ts']).not.toContain(
		"import('kody:runtime')",
	)
})

test('buildKodyAppBundle runtime module exports service helper', async () => {
	mockModule.createWorker.mockResolvedValue(
		createBundleResult('runtime-service-helper'),
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
		return Response.json({ ok: true })
	},
}
`,
			'index.ts': 'export const value = "ok"',
		},
		entryPoint: 'app.ts',
		cacheKey: null,
	})

	const firstCall = mockModule.createWorker.mock.calls.at(-1)?.[0] as
		| {
				files?: Record<string, string>
		  }
		| undefined
	expect(firstCall?.files?.['.__kody_virtual__/runtime.js']).toContain(
		'export const service = runtime.service ?? null;',
	)
})
