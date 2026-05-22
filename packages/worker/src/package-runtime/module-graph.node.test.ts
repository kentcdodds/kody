import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
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

const {
	buildKodyAppBundle,
	createPublishedPackageAppBundleCacheKey,
	createRuntimeModuleSource,
	hydrateKodyRuntimeModules,
} = await import('./module-graph.ts')

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite resets shared hoisted mocks between tests.
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

async function createTemporaryModuleGraph(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'kody-module-graph-'))
	for (const [filePath, source] of Object.entries(files)) {
		const destination = join(root, filePath)
		await mkdir(dirname(destination), { recursive: true })
		await writeFile(destination, source, 'utf8')
	}
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ type: 'module' }),
		'utf8',
	)
	return {
		async importModule(modulePath: string, options?: { cacheBust?: boolean }) {
			const moduleUrl = pathToFileURL(join(root, modulePath))
			if (options?.cacheBust ?? true) {
				moduleUrl.searchParams.set('cache', crypto.randomUUID())
			}
			return await import(moduleUrl.href)
		},
		async cleanup() {
			await rm(root, { recursive: true, force: true })
		},
	}
}

type RuntimeModule = {
	__kodyRunInRuntime: <T>(
		runtime: Record<string, unknown>,
		callback: () => Promise<T>,
	) => Promise<T>
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
							serviceContext: null,
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
							serviceContext: null,
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
		expect(typeof proxyModule.default).toBe('function')
		expect(proxyModule.default({ value: 'from-published-artifact' })).toEqual({
			ok: true,
			value: 'from-published-artifact',
		})
	} finally {
		await moduleGraph.cleanup()
	}
})

test('workflow-approved-email importable artifact can be inspected without invoking the workflow', async () => {
	mockModule.createWorker.mockImplementation(
		async (input: { files: Record<string, string>; entryPoint: string }) => ({
			mainModule: input.entryPoint,
			modules: input.files,
			dependencies: [],
		}),
	)
	mockModule.getSavedPackageByName.mockImplementation(
		async (_db: unknown, input: { name: string }) =>
			input.name === '@kentcdodds/email-received-subscriber'
				? createSavedPackageRecord({
						name: '@kentcdodds/email-received-subscriber',
						kodyId: 'email-received-subscriber',
						sourceId: 'source-email-received-subscriber',
					})
				: input.name === '@kentcdodds/ai-chat'
					? createSavedPackageRecord({
							name: '@kentcdodds/ai-chat',
							kodyId: 'ai-chat',
							sourceId: 'source-ai-chat',
						})
					: null,
	)
	mockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) =>
			input.sourceId === 'source-email-received-subscriber'
				? {
						source: {
							id: 'source-email-received-subscriber',
							published_commit: 'commit-email-received-subscriber',
						},
						manifest: {
							name: '@kentcdodds/email-received-subscriber',
							exports: {
								'./workflow-approved-email': './src/workflow-approved-email.ts',
							},
							kody: {
								id: 'email-received-subscriber',
								description: 'Email received subscriber',
							},
						},
						files: {
							'package.json': JSON.stringify({
								name: '@kentcdodds/email-received-subscriber',
								exports: {
									'./workflow-approved-email':
										'./src/workflow-approved-email.ts',
								},
								kody: {
									id: 'email-received-subscriber',
									description: 'Email received subscriber',
								},
							}),
							'src/workflow-approved-email.ts': [
								'import { processApprovedEmailWorkflow } from "./core.js"',
								'export default function workflowApprovedEmail(input = {}) {',
								'\treturn processApprovedEmailWorkflow(input)',
								'}',
							].join('\n'),
						},
					}
				: input.sourceId === 'source-ai-chat'
					? {
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
									description: 'AI chat',
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
										description: 'AI chat',
									},
								}),
								'src/index.ts':
									'export default async function runAgentTurn() { return { ok: true } }',
							},
						}
					: null,
	)
	const createWorkflowArtifact = () => ({
		version: 1,
		kind: 'importable-module' as const,
		artifactName: './workflow-approved-email',
		sourceId: 'source-email-received-subscriber',
		publishedCommit: 'commit-email-received-subscriber',
		entryPoint: 'src/workflow-approved-email.ts',
		mainModule: 'dist/workflow-approved-email.js',
		modules: {
			'dist/workflow-approved-email.js': [
				'import { processApprovedEmailWorkflow } from "./core.js"',
				'export default function workflowApprovedEmail(input = {}) {',
				'\treturn processApprovedEmailWorkflow(input)',
				'}',
			].join('\n'),
			'dist/core.js': [
				'export async function processApprovedEmailWorkflow(input = {}) {',
				"\tconst aiChat = await import('./.__kody_virtual__/dynamic-imports/ai-chat.js')",
				'\treturn await aiChat.default({ messages: input.messages })',
				'}',
			].join('\n'),
			'dist/.__kody_virtual__/dynamic-imports/ai-chat.js':
				'export const __kodyDynamicPackageSpecifier = "kody:@kentcdodds/ai-chat";',
		},
		dependencies: [],
		dynamicDependencies: [
			{
				specifier: 'kody:@kentcdodds/ai-chat',
				packageName: '@kentcdodds/ai-chat',
				exportName: '.',
			},
		],
		packageContext: {
			packageId: 'pkg-email-received-subscriber',
			kodyId: 'email-received-subscriber',
			sourceId: 'source-email-received-subscriber',
		},
		serviceContext: null,
		createdAt: '2026-05-13T00:00:00.000Z',
	})
	const aiChatArtifact = {
		version: 1,
		kind: 'importable-module' as const,
		artifactName: '.',
		sourceId: 'source-ai-chat',
		publishedCommit: 'commit-ai-chat',
		entryPoint: 'src/index.ts',
		mainModule: 'dist/index.js',
		modules: {
			'dist/index.js': [
				'export default async function runAgentTurn(input = {}) {',
				'\tif (!Array.isArray(input.messages) || input.messages.length === 0) {',
				'\t\tthrow new Error("messages must include at least one message.")',
				'\t}',
				'\treturn { ok: true }',
				'}',
			].join('\n'),
		},
		dependencies: [],
		dynamicDependencies: [],
		packageContext: {
			packageId: 'pkg-ai-chat',
			kodyId: 'ai-chat',
			sourceId: 'source-ai-chat',
		},
		serviceContext: null,
		createdAt: '2026-05-13T00:00:00.000Z',
	}
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: {
			kind: string
			sourceId: string
			artifactName?: string | null
			entryPoint: string
		}) => {
			if (
				input.kind === 'importable-module' &&
				input.sourceId === 'source-email-received-subscriber' &&
				input.artifactName === './workflow-approved-email' &&
				input.entryPoint === 'src/workflow-approved-email.ts'
			) {
				return {
					row: {
						id: 'artifact-workflow-approved-email',
					},
					artifact: createWorkflowArtifact(),
				}
			}
			if (
				input.kind === 'importable-module' &&
				input.sourceId === 'source-ai-chat' &&
				input.artifactName === '.' &&
				input.entryPoint === 'src/index.ts'
			) {
				return {
					row: {
						id: 'artifact-ai-chat',
					},
					artifact: aiChatArtifact,
				}
			}
			return null
		},
	)

	const { buildKodyModuleBundle } = await import('./module-graph.ts')
	const staticBundle = await buildKodyModuleBundle({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceFiles: {
			'entry.ts': [
				"import workflowApprovedEmail from 'kody:@kentcdodds/email-received-subscriber/workflow-approved-email'",
				'export default function main() {',
				'\treturn Function.prototype.toString.call(workflowApprovedEmail)',
				'}',
			].join('\n'),
		},
		entryPoint: 'entry.ts',
	})
	const staticModuleGraph = await createTemporaryModuleGraph(
		staticBundle.modules,
	)
	try {
		const entry = (await staticModuleGraph.importModule(
			staticBundle.mainModule,
		)) as {
			default: () => Promise<string>
		}
		await expect(entry.default()).resolves.toContain('workflowApprovedEmail')
	} finally {
		await staticModuleGraph.cleanup()
	}

	const hydratedModules = await hydrateKodyRuntimeModules({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		modules: {
			'entry.js': [
				'export default async function main() {',
				"\tconst module = await import('./.__kody_virtual__/dynamic-imports/workflow-approved-email.js')",
				'\treturn Function.prototype.toString.call(module.default)',
				'}',
			].join('\n'),
			'.__kody_virtual__/dynamic-imports/workflow-approved-email.js':
				'export const __kodyDynamicPackageSpecifier = "kody:@kentcdodds/email-received-subscriber/workflow-approved-email";',
		},
	})
	const dynamicModuleGraph = await createTemporaryModuleGraph(hydratedModules)
	try {
		const entry = (await dynamicModuleGraph.importModule('entry.js')) as {
			default: () => Promise<string>
		}
		await expect(entry.default()).resolves.toContain('workflowApprovedEmail')
	} finally {
		await dynamicModuleGraph.cleanup()
	}
})

test('hydrateKodyRuntimeModules replaces stale persisted kody runtime modules', async () => {
	const staleRuntimeSource =
		'export const codemode = { stale: true }; export default { codemode };'
	const hydratedModules = await hydrateKodyRuntimeModules({
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		modules: {
			'.__kody_virtual__/runtime.js': staleRuntimeSource,
			'entry.js': `import { __kodyRunInRuntime, codemode } from './.__kody_virtual__/runtime.js'

export async function runWithRuntime(runtime) {
	return await __kodyRunInRuntime(runtime, async () => codemode.hostRuntimeVersion({}))
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
			codemode: {
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
		'export const codemode = runtime.codemode',
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
				"import { codemode } from './.__kody_virtual__/runtime.js'",
				'',
				'export default async function runDependency() {',
				'\treturn await codemode.service_start({ source: "email" })',
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
				codemode: {
					async service_start() {
						return { ok: true }
					},
				},
			}),
		).rejects.toThrow(
			"Cannot read properties of undefined (reading 'service_start')",
		)
	} finally {
		await staleModuleGraph.cleanup()
	}

	const hydratedModules = await hydrateKodyRuntimeModules({
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
			codemode: {
				async service_start(args: unknown) {
					return { ok: true, args }
				},
			},
		})
		expect(result).toEqual({
			ok: true,
			args: {
				source: 'email',
			},
		})
	} finally {
		await hydratedModuleGraph.cleanup()
	}
})

test('buildKodyModuleBundle refreshes nested artifact runtimes before static import rebundling', async () => {
	const staleRuntimeSource = [
		'const runtime = {}',
		'export const codemode = runtime.codemode',
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
				'import { codemode } from "kody:runtime"\nexport async function runAgentTurnNonStreaming() { return await codemode.value_get({ name: "ai-chat" }) }',
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
					"import { codemode } from './.__kody_virtual__/runtime.js'",
					'export async function runAgentTurnNonStreaming() {',
					'\treturn await codemode.value_get({ name: "ai-chat" })',
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
			serviceContext: null,
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

test('buildKodyModuleBundle keeps static imports pinned while literal dynamic imports resolve current packages', async () => {
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
					serviceContext: null,
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
		},
	])
	expect(bundle.dynamicDependencies).toEqual([
		{
			specifier: 'kody:@kentcdodds/example-package/value',
			packageName: '@kentcdodds/example-package',
			exportName: './value',
		},
	])
	packageVersion = 'current'
	const hydratedModules = await hydrateKodyRuntimeModules({
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
		await expect(entry.default()).resolves.toEqual({
			staticValue: 'pinned',
			dynamicValue: 'current',
			dynamicMarker: 'current',
		})
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
	const hydratedModules = await hydrateKodyRuntimeModules({
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
			'Computed dynamic Kody package imports are unsupported',
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
					.replace('kody:', '')
					.split('/')
					.slice(0, 2)
					.join('/'),
				exportName: './run',
			},
		],
		packageContext: null,
		serviceContext: null,
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

	const hydratedModules = await hydrateKodyRuntimeModules({
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
		name: 'subscription service start',
		entryPoint: 'src/handle-email-message-received.ts',
		source: `import { codemode } from 'kody:runtime'

export default async function handleEmailMessageReceived() {
	return await codemode.service_start({
		package_id: 'pkg-1',
		service_name: 'email-agent-processor',
	})
}
`,
		codemode: {
			async service_start(input: unknown) {
				return { ok: true, tool: 'service_start', input }
			},
		},
		expected: {
			ok: true,
			tool: 'service_start',
			input: {
				package_id: 'pkg-1',
				service_name: 'email-agent-processor',
			},
		},
	},
	{
		name: 'export secret list',
		entryPoint: 'src/launch-agent.ts',
		source: `import { codemode } from 'kody:runtime'

export default async function launchAgent() {
	return await codemode.secret_list({ scope: 'user' })
}
`,
		codemode: {
			async secret_list(input: unknown) {
				return { ok: true, tool: 'secret_list', input }
			},
		},
		expected: {
			ok: true,
			tool: 'secret_list',
			input: { scope: 'user' },
		},
	},
])(
	'buildKodyModuleBundle keeps codemode available for a preloaded package $name runtime',
	async ({ entryPoint, source, codemode, expected }) => {
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
		const hydratedModules = await hydrateKodyRuntimeModules({
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
			const result = await runtime.__kodyRunInRuntime(
				{ codemode },
				async () => {
					const entry = (await moduleGraph.importModule(bundle.mainModule, {
						cacheBust: false,
					})) as { default: (input?: unknown) => Promise<unknown> }
					return await entry.default({})
				},
			)

			expect(result).toEqual(expected)
		} finally {
			await moduleGraph.cleanup()
		}
	},
)

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
		},
		{
			sourceId: 'source-bob',
			publishedCommit: 'commit-source-bob',
			kodyId: 'shared-package',
			packageName: '@bob/shared-package',
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

test('buildKodyAppBundle runtime module exports service and package invocation helpers', async () => {
	const appBundleInput = {
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
	}

	mockModule.createWorker.mockResolvedValue(
		createBundleResult('runtime-service-helper'),
	)
	await buildKodyAppBundle(appBundleInput)
	const serviceRuntime =
		(
			mockModule.createWorker.mock.calls.at(-1)?.[0] as
				| { files?: Record<string, string> }
				| undefined
		)?.files?.['.__kody_virtual__/runtime.js'] ?? ''
	expect(serviceRuntime).toContain(
		'export const service = runtime.service ?? null;',
	)
	expect(serviceRuntime).toContain(
		"import { AsyncLocalStorage } from 'node:async_hooks';",
	)
	expect(serviceRuntime).toContain('export function __kodyRunInRuntime')
	expect(serviceRuntime).not.toContain('params')

	mockModule.createWorker.mockResolvedValue(
		createBundleResult('runtime-packages-helper'),
	)
	await buildKodyAppBundle(appBundleInput)
	const packageRuntime =
		(
			mockModule.createWorker.mock.calls.at(-1)?.[0] as
				| { files?: Record<string, string> }
				| undefined
		)?.files?.['.__kody_virtual__/runtime.js'] ?? ''
	expect(packageRuntime).toContain(
		'export const packages = runtime.packages ?? null;',
	)
	expect(packageRuntime).toContain(
		'export const secretHeaders = runtime.secretHeaders;',
	)
	expect(packageRuntime).toContain(
		'export const oauthClientCredentials = runtime.oauthClientCredentials;',
	)
})
