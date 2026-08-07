import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	createFileSystemSnapshot: vi.fn(),
	createTypescriptLanguageService: vi.fn(),
	buildKodyAppBundle: vi.fn(),
	buildKodyImportableModuleBundle: vi.fn(),
	buildKodyModuleBundle: vi.fn(),
}))

vi.mock('#worker/worker-bundler-modules.ts', () => ({
	importWorkerBundler: async () => ({
		createFileSystemSnapshot: (...args: Array<unknown>) =>
			mockModule.createFileSystemSnapshot(...args),
	}),
	importWorkerBundlerTypescript: async () => ({
		createTypescriptLanguageService: (...args: Array<unknown>) =>
			mockModule.createTypescriptLanguageService(...args),
	}),
}))

vi.mock('#worker/package-runtime/module-graph.ts', () => ({
	buildKodyAppBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyAppBundle(...args),
	buildKodyImportableModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyImportableModuleBundle(...args),
	buildKodyModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyModuleBundle(...args),
}))

import {
	repoChecksSourceMaxFiles,
	repoChecksSourceMaxTotalBytes,
	runRepoChecks,
} from './checks.ts'
import { isolatedBundleChunkSize } from './isolated-check-phases.ts'
import { maxRepoSourceFileBytes } from './large-file-policy.ts'

type MockSnapshot = {
	read: ReturnType<typeof vi.fn>
}

type MockTypeScriptFileSystem = MockSnapshot & {
	write: ReturnType<typeof vi.fn>
}

function createSnapshotFromFiles(files: Map<string, string>): MockSnapshot {
	return {
		read: vi.fn((path: string) => files.get(path) ?? null),
	}
}

function setupDefaultBundleMocks() {
	mockModule.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js':
				'export default { async fetch() { return new Response("ok") } }',
		},
		dependencies: [],
	})
	mockModule.buildKodyModuleBundle.mockResolvedValue({
		mainModule: 'dist/module.js',
		modules: {
			'dist/module.js': 'export default async function run() { return "ok" }',
		},
		dependencies: [],
	})
	mockModule.buildKodyImportableModuleBundle.mockResolvedValue({
		mainModule: 'dist/importable.js',
		modules: {
			'dist/importable.js': 'export const ready = true',
		},
		dependencies: [],
	})
}

async function collectSnapshotFiles(
	input: AsyncIterable<readonly [string, string]>,
) {
	const snapshotFiles = new Map<string, string>()
	for await (const [path, content] of input) {
		snapshotFiles.set(path, content)
	}
	return snapshotFiles
}

async function runChecksOnWorkspaceFiles(files: Map<string, string>) {
	setupDefaultBundleMocks()
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	return runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
	})
}

function createPackageManifest(input: {
	packageName: string
	kodyId: string
	description: string
	exports?: Record<
		string,
		string | { import?: string; default?: string; types?: string }
	>
	jobs?: Record<string, { entry: string; schedule: Record<string, unknown> }>
	subscriptions?: Record<
		string,
		{ handler: string; description?: string; filters?: Record<string, unknown> }
	>
	emits?: Record<string, { description: string }>
	services?: Record<string, { entry: string }>
	kodyDependencies?: Array<string>
	retrievers?: Record<
		string,
		{
			export: string
			name: string
			description: string
			scopes: Array<'search' | 'context'>
		}
	>
	appEntry?: string
}) {
	return JSON.stringify({
		name: input.packageName,
		exports:
			input.exports ??
			({
				'.': './src/index.ts',
			} satisfies Record<string, string>),
		kody: {
			id: input.kodyId,
			description: input.description,
			dependencies: input.kodyDependencies,
			app: input.appEntry
				? {
						entry: input.appEntry,
					}
				: undefined,
			jobs: input.jobs,
			subscriptions: input.subscriptions,
			emits: input.emits,
			services: input.services,
			retrievers: input.retrievers,
		},
	})
}

async function runPackageJobTypecheckChecks(
	files: Map<string, string>,
	options?: {
		getSemanticDiagnostics?: ReturnType<typeof vi.fn>
	},
) {
	setupDefaultBundleMocks()
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics =
		options?.getSemanticDiagnostics ?? vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
	})

	return { result, typeScriptFileSystem, getSemanticDiagnostics }
}

test('runRepoChecks fails when the source root exceeds publish size caps', async () => {
	const tooManyFiles = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/too-many-files',
				kodyId: 'too-many-files',
				description: 'Exceeds the publish check file cap',
			}),
		],
		['src/index.ts', 'export const ready = true\n'],
	])
	for (let index = 0; index < repoChecksSourceMaxFiles; index += 1) {
		tooManyFiles.set(`generated/file-${index}.txt`, 'x')
	}
	const fileCountResult = await runChecksOnWorkspaceFiles(tooManyFiles)
	expect(fileCountResult.ok).toBe(false)
	expect(fileCountResult.sourceFiles).toEqual({})
	expect(fileCountResult.results).toEqual([
		expect.objectContaining({ kind: 'manifest', ok: true }),
		expect.objectContaining({ kind: 'bundle', ok: false }),
	])

	const halfCapChunk = 'x'.repeat(repoChecksSourceMaxTotalBytes / 2)
	const byteCountResult = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/too-many-bytes',
					kodyId: 'too-many-bytes',
					description: 'Exceeds the publish check byte cap',
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
			['assets/blob-1.bin', halfCapChunk],
			['assets/blob-2.bin', halfCapChunk],
			['assets/blob-3.bin', halfCapChunk],
		]),
	)
	expect(byteCountResult.ok).toBe(false)
	expect(byteCountResult.sourceFiles).toEqual({})
	expect(byteCountResult.results).toEqual([
		expect.objectContaining({ kind: 'manifest', ok: true }),
		expect.objectContaining({ kind: 'bundle', ok: false }),
	])
})

test('runRepoChecks fails a single file over the per-file limit with hosting guidance', async () => {
	const oversized = 'x'.repeat(maxRepoSourceFileBytes + 1)
	const result = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/one-large-file',
					kodyId: 'one-large-file',
					description: 'Exceeds the per-file publish limit',
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
			['assets/dataset.csv', oversized],
		]),
	)
	expect(result.ok).toBe(false)
	expect(result.sourceFiles).toEqual({})
	const bundleCheck = result.results.find((check) => check.kind === 'bundle')
	expect(bundleCheck?.ok).toBe(false)
	expect(bundleCheck?.message).toContain('"assets/dataset.csv"')
	expect(bundleCheck?.message).toContain('per-file limit')
})

test('runRepoChecks keeps non-code source files for publish snapshots while excluding git internals', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/static-assets',
				kodyId: 'static-assets',
				description: 'Includes static assets',
				exports: {
					'.': './src/index.ts',
				},
			}),
		],
		['src/index.ts', 'export const ready = true\n'],
		['styles/app.css', 'body { color: red; }\n'],
		['public/icon.svg', '<svg />\n'],
		['.git/config', '[remote "origin"]\n'],
	])
	let globPattern = ''
	let snapshotFiles = new Map<string, string>()
	const snapshot = createSnapshotFromFiles(snapshotFiles)
	mockModule.createFileSystemSnapshot.mockImplementation(async (input) => {
		snapshotFiles = await collectSnapshotFiles(
			input as AsyncIterable<readonly [string, string]>,
		)
		snapshot.read.mockImplementation(
			(path: string) => snapshotFiles.get(path) ?? null,
		)
		return snapshot
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob(pattern: string) {
				globPattern = pattern
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
	})

	expect(globPattern).toBe('**/*')
	expect(result.sourceFiles).toEqual({
		'package.json': files.get('package.json'),
		'src/index.ts': files.get('src/index.ts'),
		'styles/app.css': files.get('styles/app.css'),
		'public/icon.svg': files.get('public/icon.svg'),
	})
	expect(snapshotFiles.has('.git/config')).toBe(false)
})

test('runRepoChecks strips repo-session workspace prefixes from package snapshot paths', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'/session/package.json',
			createPackageManifest({
				packageName: '@kody/session-backed-job',
				kodyId: 'session-backed-job',
				description: 'Runs from a repo session workspace',
				exports: {
					'.': './src/index.ts',
				},
				jobs: {
					session: {
						entry: '/src/job.ts',
						schedule: {
							type: 'once',
							runAt: '2026-04-17T15:00:00Z',
						},
					},
				},
			}),
		],
		['/session/src/index.ts', 'export const ready = true\n'],
		['/session/src/job.ts', 'export default async () => ({ ok: true })\n'],
	])
	let snapshotFiles = new Map<string, string>()
	const snapshot = createSnapshotFromFiles(snapshotFiles)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn((path: string, content: string) => {
			snapshotFiles.set(path, content)
		}),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockImplementation(async (input) => {
		snapshotFiles = await collectSnapshotFiles(
			input as AsyncIterable<readonly [string, string]>,
		)
		snapshot.read.mockImplementation(
			(path: string) => snapshotFiles.get(path) ?? null,
		)
		return snapshot
	})
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: '/session/package.json',
		sourceRoot: '/session/',
	})

	expect(result.ok).toBe(true)
	expect(Array.from(snapshotFiles.keys())).toEqual([
		'package.json',
		'src/index.ts',
		'src/job.ts',
		'.__kody_repo_runtime__.d.ts',
		'.__kody_repo_module_check__.ts',
	])
	expect(snapshot.read).toHaveBeenCalledWith('src/index.ts')
	expect(snapshot.read).toHaveBeenCalledWith('src/job.ts')
	expect(snapshot.read).not.toHaveBeenCalledWith('/src/job.ts')
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
	)
})

test('runRepoChecks typechecks package-owned jobs (runtime globals, emits, and ESM entrypoints)', async () => {
	const runtimeGlobals = await runPackageJobTypecheckChecks(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/runtime-globals-job',
					kodyId: 'runtime-globals-job',
					description: 'Uses execute globals',
					jobs: {
						runtime: {
							entry: 'src/job.ts',
							schedule: {
								type: 'once',
								runAt: '2026-04-17T15:00:00Z',
							},
						},
					},
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
			[
				'src/job.ts',
				`export default async (params) => {
  await kody.value_get({ name: 'projectId' })
  await storage.get('count')
  return params
}
`,
			],
		]),
	)
	expect(runtimeGlobals.result.ok).toBe(true)
	expect(runtimeGlobals.result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'dependencies', ok: true }),
			expect.objectContaining({ kind: 'typecheck', ok: true }),
		]),
	)
	expect(runtimeGlobals.getSemanticDiagnostics).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
	)

	const emitsConstrained = await runPackageJobTypecheckChecks(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kentcdodds/discord-gateway',
					kodyId: 'discord-gateway',
					description: 'Discord gateway package',
					emits: {
						'@kentcdodds/discord.message.created': {
							description: 'A Discord message was created.',
						},
					},
					jobs: {
						runtime: {
							entry: 'src/job.ts',
							schedule: {
								type: 'once',
								runAt: '2026-04-17T15:00:00Z',
							},
						},
					},
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
			[
				'src/job.ts',
				`import { events } from 'kody:runtime'

export default async () => {
  await events.dispatch({
    topic: '@kentcdodds/discord.message.created',
    idempotencyKey: 'discord:message-create:123',
  })
}
`,
			],
		]),
	)
	expect(emitsConstrained.result.ok).toBe(true)
	expect(emitsConstrained.result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'typecheck', ok: true }),
		]),
	)

	const esmEntrypoint = await runPackageJobTypecheckChecks(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/esm-job',
					kodyId: 'esm-job',
					description: 'Uses exports',
					jobs: {
						esm: {
							entry: 'src/job.ts',
							schedule: {
								type: 'once',
								runAt: '2026-04-17T15:00:00Z',
							},
						},
					},
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
			['src/job.ts', 'export default async () => ({ ok: true })\n'],
		]),
		{
			getSemanticDiagnostics: vi.fn((path: string) =>
				path === '.__kody_repo_module_check__.ts'
					? []
					: [{ messageText: `unexpected diagnostics for ${path}` }],
			),
		},
	)
	expect(esmEntrypoint.result.ok).toBe(true)
	expect(esmEntrypoint.result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'typecheck', ok: true }),
		]),
	)
	expect(esmEntrypoint.typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.any(String),
	)
	expect(esmEntrypoint.typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/index"'),
	)
})

test('runRepoChecks validates every persisted package artifact target before publish', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/persisted-artifacts',
				kodyId: 'persisted-artifacts',
				description: 'Exports package runtime targets',
				exports: {
					'.': './src/index.ts',
					'./job': './src/job.ts',
					'./search': './src/search.ts',
					'./subscription': './src/subscription.ts',
				},
				jobs: {
					digest: {
						entry: 'src/job.ts',
						schedule: {
							type: 'once',
							runAt: '2026-04-17T15:00:00Z',
						},
					},
				},
				subscriptions: {
					'email.message.received': {
						handler: './src/subscription.ts',
					},
				},
				retrievers: {
					search: {
						export: './search',
						name: 'Search',
						description: 'Searches package records.',
						scopes: ['search'],
					},
				},
			}),
		],
		[
			'src/index.ts',
			'export default async () => ({ ready: true })\nexport const ready = true\n',
		],
		[
			'src/job.ts',
			`export default async (params) => {
  const result = await kody.value_get({ name: 'projectId' })
  await storage.get('count')
  return { params, result }
}
`,
		],
		['src/search.ts', 'export default async (params) => ({ results: [] })\n'],
		['src/subscription.ts', 'export default async (event) => event\n'],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'bundle', ok: true }),
			expect.objectContaining({ kind: 'typecheck', ok: true }),
		]),
	)
	expect(mockModule.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
		}),
	)
	expect(mockModule.buildKodyImportableModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
		}),
	)
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
	)
})

test('runRepoChecks still reports unknown globals for package-owned jobs', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/broken-job',
				kodyId: 'broken-job',
				description: 'Uses unknown runtime symbol',
				jobs: {
					broken: {
						entry: 'src/job.ts',
						schedule: {
							type: 'once',
							runAt: '2026-04-17T15:00:00Z',
						},
					},
				},
			}),
		],
		['src/index.ts', 'export const ready = true\n'],
		['src/job.ts', 'export default async () => totallyMissingThing()\n'],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn((path: string) =>
		path === '.__kody_repo_module_check__.ts'
			? [
					{
						messageText: "Cannot find name 'totallyMissingThing'.",
						start: 0,
						file: {
							getLineAndCharacterOfPosition() {
								return {
									line: 1,
									character: 11,
								}
							},
						},
					},
				]
			: [],
	)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
	})

	expect(result.ok).toBe(false)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'typecheck',
				ok: false,
				message: expect.stringContaining(
					`Cannot find name 'totallyMissingThing'.`,
				),
			}),
		]),
	)
})

test('runRepoChecks injects package tsconfig overlays that allow optional .ts imports', async () => {
	setupDefaultBundleMocks()
	const jobManifest = {
		packageName: '@kody/ts-extension-job',
		kodyId: 'ts-extension-job',
		description: 'Imports a sibling .ts module',
		jobs: {
			tsExtension: {
				entry: 'src/job.ts',
				schedule: {
					type: 'once',
					runAt: '2026-04-17T15:00:00Z',
				},
			},
		},
	} as const
	const sharedSources = [
		['src/index.ts', 'export const ready = true\n'],
		['src/job.ts', 'export { default } from "./helper.ts"\n'],
		['src/helper.ts', 'export default async () => ({ ok: true })\n'],
	] as const

	async function runTsExtensionChecks(files: Map<string, string>) {
		const snapshot = createSnapshotFromFiles(files)
		const typeScriptFileSystem: MockTypeScriptFileSystem = {
			...snapshot,
			write: vi.fn(),
		}
		mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
		mockModule.createTypescriptLanguageService.mockResolvedValue({
			fileSystem: typeScriptFileSystem,
			languageService: {
				dispose: vi.fn(),
				getSemanticDiagnostics: vi.fn(() => []),
			},
		})

		const result = await runRepoChecks({
			workspace: {
				async readFile(path: string) {
					return files.get(path) ?? null
				},
				async glob() {
					return Array.from(files.keys()).map((path) => ({
						path,
						type: 'file',
					}))
				},
			},
			manifestPath: 'package.json',
			sourceRoot: '/',
		})

		return { result, typeScriptFileSystem }
	}

	const withoutRepoTsconfig = new Map<string, string>([
		['package.json', createPackageManifest(jobManifest)],
		...sharedSources,
	])
	const syntheticOnly = await runTsExtensionChecks(withoutRepoTsconfig)
	expect(syntheticOnly.result.ok).toBe(true)
	const syntheticTypecheckInput =
		mockModule.createTypescriptLanguageService.mock.calls.at(-1)?.[0] as {
			fileSystem: MockTypeScriptFileSystem
		}
	expect(
		JSON.parse(
			syntheticTypecheckInput.fileSystem.read('tsconfig.json') ?? 'null',
		),
	).toMatchObject({
		compilerOptions: {
			allowImportingTsExtensions: true,
			noEmit: true,
		},
	})
	expect(
		syntheticTypecheckInput.fileSystem.read(
			'./.__kody_repo_tsconfig_base__.json',
		),
	).toBe(null)

	const repoTsconfig = JSON.stringify({
		compilerOptions: {
			module: 'NodeNext',
			moduleResolution: 'NodeNext',
			strict: true,
		},
	})
	const withRepoTsconfig = new Map<string, string>([
		['package.json', createPackageManifest(jobManifest)],
		['tsconfig.json', repoTsconfig],
		...sharedSources,
	])
	const extendsRepoBase = await runTsExtensionChecks(withRepoTsconfig)
	expect(extendsRepoBase.result.ok).toBe(true)
	const extendsTypecheckInput =
		mockModule.createTypescriptLanguageService.mock.calls.at(-1)?.[0] as {
			fileSystem: MockTypeScriptFileSystem
		}
	expect(
		JSON.parse(
			extendsTypecheckInput.fileSystem.read('tsconfig.json') ?? 'null',
		),
	).toMatchObject({
		extends: './.__kody_repo_tsconfig_base__.json',
		compilerOptions: {
			allowImportingTsExtensions: true,
			noEmit: true,
		},
	})
	expect(
		extendsTypecheckInput.fileSystem.read('.__kody_repo_tsconfig_base__.json'),
	).toBe(repoTsconfig)
})

test('runRepoChecks returns a failed manifest check for object-shaped kody.dependencies instead of throwing', async () => {
	// Agents sometimes confuse npm dependencies (object map) with
	// kody.dependencies (string array). Publish must return checks_failed, not
	// throw — otherwise MCP observability opens a Sentry platform-bug issue.
	const result = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				JSON.stringify({
					name: '@kody/object-deps',
					exports: {
						'.': './src/index.ts',
					},
					kody: {
						id: 'object-deps',
						description: 'Uses object-shaped kody.dependencies by mistake',
						dependencies: {
							'@kentcdodds/helper': 'latest',
						},
					},
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
		]),
	)
	expect(result.ok).toBe(false)
	expect(result.manifest).toBeNull()
	expect(result.results).toEqual([
		expect.objectContaining({
			kind: 'manifest',
			ok: false,
			message: expect.stringMatching(
				/expected array, received object[\s\S]*kody\.dependencies/,
			),
		}),
	])
})

test('runRepoChecks validates static kody package import declarations across missing, declared, type-only, declaration files, mixed exports, dynamic imports, invalid declarations, and unused declarations', async () => {
	const missingDeclaration = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/uses-static-package',
					kodyId: 'uses-static-package',
					description: 'Uses a static Kody package import',
				}),
			],
			[
				'src/index.ts',
				'import helper from "kody:@kentcdodds/helper/run"\nexport const ready = helper\n',
			],
		]),
	)
	expect(missingDeclaration.ok).toBe(false)
	expect(missingDeclaration.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: false,
				message: expect.stringMatching(/@kentcdodds\/helper/),
			}),
		]),
	)

	const declaredImports = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/declared-static-package',
					kodyId: 'declared-static-package',
					description: 'Declares static Kody package imports',
					kodyDependencies: ['@kentcdodds/helper'],
				}),
			],
			[
				'src/index.ts',
				[
					'import helper from "kody:@kentcdodds/helper/run"',
					'import type { HelperConfig } from "kody:@kentcdodds/types/config"',
					'export { type HelperResult } from "kody:@kentcdodds/types/result"',
					'export const ready: HelperConfig | unknown = helper',
				].join('\n'),
			],
		]),
	)
	expect(declaredImports.ok).toBe(true)
	expect(declaredImports.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
			}),
		]),
	)

	const declarationFileTypes = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/declaration-file-types',
					kodyId: 'declaration-file-types',
					description: 'Exports declaration-only types',
					exports: {
						'.': {
							import: './src/index.ts',
							types: './src/index.d.ts',
						},
					},
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
			[
				'src/index.d.ts',
				'import { HelperConfig } from "kody:@kentcdodds/types/config"\nexport type Options = HelperConfig\n',
			],
		]),
	)
	expect(declarationFileTypes.ok).toBe(true)
	expect(declarationFileTypes.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
			}),
		]),
	)

	const mixedExport = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/mixed-export-package',
					kodyId: 'mixed-export-package',
					description: 'Exports a value from another Kody package',
				}),
			],
			[
				'src/index.ts',
				'export { run, type RunInput } from "kody:@kentcdodds/runner"\n',
			],
		]),
	)
	expect(mixedExport.ok).toBe(false)
	expect(mixedExport.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: false,
				message: expect.stringContaining('missing "@kentcdodds/runner"'),
			}),
		]),
	)

	const dynamicImport = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/dynamic-import-package',
					kodyId: 'dynamic-import-package',
					description: 'Dynamically imports another Kody package',
				}),
			],
			[
				'src/index.ts',
				'export async function load() { return await import("kody:@kentcdodds/dynamic/run") }\n',
			],
		]),
	)
	expect(dynamicImport.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
			}),
		]),
	)

	const invalidDeclaration = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				JSON.stringify({
					name: '@kody/invalid-dependency-declaration',
					exports: {
						'.': './src/index.ts',
					},
					kody: {
						id: 'invalid-dependency-declaration',
						description: 'Declares an invalid Kody dependency',
						dependencies: ['@kentcdodds/helper/run'],
					},
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
		]),
	)
	expect(invalidDeclaration.ok).toBe(false)
	expect(invalidDeclaration.manifest).toBeNull()
	expect(invalidDeclaration.results).toEqual([
		expect.objectContaining({
			kind: 'manifest',
			ok: false,
			message: expect.stringContaining(
				'Static Kody package dependencies must be scoped package names like "@scope/package".',
			),
		}),
	])

	const unusedDeclaration = await runChecksOnWorkspaceFiles(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/unused-static-package',
					kodyId: 'unused-static-package',
					description: 'Declares an unused Kody package dependency',
					kodyDependencies: ['@kentcdodds/unused'],
				}),
			],
			['src/index.ts', 'export const ready = true\n'],
		]),
	)
	expect(unusedDeclaration.ok).toBe(false)
	expect(unusedDeclaration.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: false,
				message: expect.stringMatching(/@kentcdodds\/unused/),
			}),
		]),
	)
})

test('runRepoChecks surfaces bundle validation failures when runtime bundling cannot resolve npm dependencies', async () => {
	setupDefaultBundleMocks()
	const unresolvedModuleFiles = new Map<string, string>([
		[
			'package.json',
			JSON.stringify({
				name: '@kody/broken-dependency-package',
				exports: {
					'.': './src/index.ts',
				},
				dependencies: {
					marked: '^16.3.0',
				},
				kody: {
					id: 'broken-dependency-package',
					description: 'Fails to bundle npm dependency',
				},
			}),
		],
		[
			'src/index.ts',
			'import { marked } from "marked"\nexport default async () => marked.parse("**ok**")\n',
		],
	])
	const unresolvedSnapshot = createSnapshotFromFiles(unresolvedModuleFiles)
	const unresolvedTypeScriptFileSystem: MockTypeScriptFileSystem = {
		...unresolvedSnapshot,
		write: vi.fn(),
	}
	mockModule.createFileSystemSnapshot.mockResolvedValue(unresolvedSnapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: unresolvedTypeScriptFileSystem,
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	mockModule.buildKodyImportableModuleBundle.mockRejectedValueOnce(
		new Error('No such module "marked" imported from bundle.js'),
	)

	const unresolvedResult = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return unresolvedModuleFiles.get(path) ?? null
			},
			async glob() {
				return Array.from(unresolvedModuleFiles.keys()).map((path) => ({
					path,
					type: 'file',
				}))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})

	expect(unresolvedResult.ok).toBe(false)
	expect(unresolvedResult.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringContaining(
					'No such module "marked" imported from bundle.js',
				),
			}),
		]),
	)
	expect(mockModule.buildKodyImportableModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
			userId: 'user-123',
		}),
	)
	expect(mockModule.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
			userId: 'user-123',
		}),
	)

	const unresolvedVersionFiles = new Map<string, string>([
		[
			'package.json',
			JSON.stringify({
				name: '@kody/broken-npm-package',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'broken-npm-package',
					description: 'Broken npm dependency',
				},
				dependencies: {
					marked: '18.0.2',
				},
			}),
		],
		[
			'src/index.ts',
			'import { marked } from "marked"\nexport default async () => marked.parse("**ok**")\n',
		],
	])
	const unresolvedVersionSnapshot = createSnapshotFromFiles(
		unresolvedVersionFiles,
	)
	const unresolvedVersionTypeScriptFileSystem: MockTypeScriptFileSystem = {
		...unresolvedVersionSnapshot,
		write: vi.fn(),
	}
	mockModule.createFileSystemSnapshot.mockResolvedValue(
		unresolvedVersionSnapshot,
	)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: unresolvedVersionTypeScriptFileSystem,
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	mockModule.buildKodyImportableModuleBundle.mockRejectedValueOnce(
		new Error('Could not resolve version for marked@18.0.2'),
	)

	const unresolvedVersionResult = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return unresolvedVersionFiles.get(path) ?? null
			},
			async glob() {
				return Array.from(unresolvedVersionFiles.keys()).map((path) => ({
					path,
					type: 'file',
				}))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})

	expect(unresolvedVersionResult.ok).toBe(false)
	expect(unresolvedVersionResult.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringContaining(
					'src/index.ts: Could not resolve version for marked@18.0.2',
				),
			}),
		]),
	)
})

test('runRepoChecks fails before publish when an exported module artifact cannot be built', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			JSON.stringify({
				name: '@kody/named-only-export',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'named-only-export',
					description: 'Exports a helper that is not callable.',
				},
			}),
		],
		['src/index.ts', 'export const ready = true\n'],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	mockModule.buildKodyModuleBundle.mockRejectedValueOnce(
		new Error('No matching default export for import "default"'),
	)

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})

	expect(result.ok).toBe(false)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringContaining(
					'src/index.ts: No matching default export for import "default"',
				),
			}),
		]),
	)
	expect(mockModule.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
			userId: 'user-123',
		}),
	)
	expect(mockModule.buildKodyImportableModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
			userId: 'user-123',
		}),
	)
})

test('runRepoChecks validates package runtime bundles with npm dependencies', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			JSON.stringify({
				name: '@kody/npm-deps-package',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'npm-deps-package',
					description: 'Uses npm dependencies',
					services: {
						processor: {
							entry: './src/service.ts',
						},
					},
				},
				dependencies: {
					marked: '18.0.2',
				},
			}),
		],
		['src/index.ts', 'export default async () => "ok"\n'],
		[
			'src/service.ts',
			'import { marked } from "marked"\nexport default async () => marked.parse("**ok**")\n',
		],
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics,
		},
	})

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'dependencies', ok: true }),
			expect.objectContaining({ kind: 'bundle', ok: true }),
		]),
	)
	expect(mockModule.buildKodyImportableModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
			sourceFiles: {
				'package.json': files.get('package.json'),
				'src/index.ts': files.get('src/index.ts'),
				'src/service.ts': files.get('src/service.ts'),
			},
		}),
	)
	expect(mockModule.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/service.ts',
		}),
	)
})

test('runRepoChecks fails ambient storage imports in package code with the packageStorage() remedy', async () => {
	// A runtime module importing the ambient `storage` helper fails the lint
	// check with an actionable message (stage two of the ambient-storage
	// removal: the #817 advisory nudge is now enforced on new check runs).
	const ambientStorage = await runPackageJobTypecheckChecks(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/ambient-storage-package',
					kodyId: 'ambient-storage-package',
					description: 'Imports ambient storage',
				}),
			],
			[
				'src/index.ts',
				`import { storage } from 'kody:runtime'

export default async function main() {
	return await storage.get('key')
}
`,
			],
		]),
	)
	expect(ambientStorage.result.ok).toBe(false)
	const ambientStorageLint = ambientStorage.result.results.find(
		(entry) => entry.kind === 'lint',
	)
	expect(ambientStorageLint).toMatchObject({ kind: 'lint', ok: false })
	expect(ambientStorageLint?.message).toContain('"src/index.ts"')
	expect(ambientStorageLint?.message).toContain('packageStorage()')
	expect(ambientStorageLint?.message).toContain('`storageId`')

	// packageStorage()-only package code passes; the lint result stays the
	// placeholder.
	const prescribedStorage = await runPackageJobTypecheckChecks(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/package-storage-package',
					kodyId: 'package-storage-package',
					description: 'Uses packageStorage',
				}),
			],
			[
				'src/index.ts',
				`import { packageStorage } from 'kody:runtime'

export default async function main() {
	return await packageStorage().get('key')
}
`,
			],
		]),
	)
	expect(prescribedStorage.result.ok).toBe(true)
	expect(prescribedStorage.result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'lint',
				ok: true,
				message: 'Lint placeholder passed for this phase.',
			}),
		]),
	)

	// Type-only imports and declaration files are not runtime accesses, and
	// aliased runtime imports of other helpers do not match; the check passes.
	const typeOnly = await runPackageJobTypecheckChecks(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/type-only-storage-package',
					kodyId: 'type-only-storage-package',
					description: 'Type-only storage import',
				}),
			],
			[
				'src/index.ts',
				`import type { storage } from 'kody:runtime'
import { kody as client } from 'kody:runtime'

export default async function main() {
	void (null as unknown as typeof storage)
	return await client.value_get({ name: 'projectId' })
}
`,
			],
			[
				'src/types.d.ts',
				`import { storage } from 'kody:runtime'
export type Bucket = typeof storage
`,
			],
		]),
	)
	expect(typeOnly.result.ok).toBe(true)
	expect(typeOnly.result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'lint',
				ok: true,
				message: 'Lint placeholder passed for this phase.',
			}),
		]),
	)

	// Aliased ambient storage imports still fail: the imported name is what
	// identifies the helper, not the local binding.
	const aliasedStorage = await runPackageJobTypecheckChecks(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/aliased-storage-package',
					kodyId: 'aliased-storage-package',
					description: 'Aliased ambient storage import',
				}),
			],
			[
				'src/index.ts',
				`import { storage as bucket } from 'kody:runtime'

export default async function main() {
	return await bucket.get('key')
}
`,
			],
		]),
	)
	expect(aliasedStorage.result.ok).toBe(false)
	const aliasedStorageLint = aliasedStorage.result.results.find(
		(entry) => entry.kind === 'lint',
	)
	expect(aliasedStorageLint).toMatchObject({ kind: 'lint', ok: false })
	expect(aliasedStorageLint?.message).toContain('packageStorage()')
})

test('runRepoChecks rejects unsupported invocation forms with replacements named', async () => {
	// Permanent contract: packages.check, packages.invokeChecked, and literal
	// dynamic import("kody:@...") fail publishes; the message names each usage,
	// its replacement, and the repair codemod.
	const removed = await runPackageJobTypecheckChecks(
		new Map<string, string>([
			[
				'package.json',
				createPackageManifest({
					packageName: '@kody/removed-invocation-package',
					kodyId: 'removed-invocation-package',
					description: 'Uses the removed dynamic invocation APIs',
				}),
			],
			[
				'src/index.ts',
				`import { packages } from 'kody:runtime'

export default async function main() {
	const dynamicModule = await import('kody:@kentcdodds/example-package/value')
	await packages?.check({ kodyId: 'example-package', exportName: './value' })
	return await packages?.invokeChecked({
		kodyId: 'example-package',
		exportName: './value',
		params: { fromDynamic: typeof dynamicModule.default },
	})
}
`,
			],
		]),
	)
	expect(removed.result.ok).toBe(false)
	const removedLint = removed.result.results.find(
		(entry) => entry.kind === 'lint',
	)
	expect(removedLint).toMatchObject({ kind: 'lint', ok: false })
	expect(removedLint?.message).toContain('removed dynamic invocation surface')
	expect(removedLint?.message).toContain('"src/index.ts"')
	expect(removedLint?.message).toContain('packages.invokeChecked was removed')
	expect(removedLint?.message).toContain('packages.check was removed')
	expect(removedLint?.message).toContain(
		'literal dynamic import("kody:@...") was removed',
	)
	expect(removedLint?.message).toContain('0002-static-first-invocation')
})

test('heavy check phases run in throwaway isolates when the env has the bindings', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/offloaded-package',
				kodyId: 'offloaded-package',
				description: 'Package with enough targets to require chunking',
				exports: {
					'.': './src/index.ts',
					'./a': './src/a.ts',
					'./b': './src/b.ts',
					'./c': './src/c.ts',
					'./d': './src/d.ts',
					'./e': './src/e.ts',
				},
				jobs: {
					daily: {
						entry: './src/index.ts',
						schedule: { type: 'interval', every: '1d' },
					},
				},
			}),
		],
		...['index', 'a', 'b', 'c', 'd', 'e'].map(
			(name) =>
				[
					`src/${name}.ts`,
					`export default async function ${name}() {\n\treturn '${name}'\n}\n`,
				] as const,
		),
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

	const phaseRequests: Array<Record<string, unknown>> = []
	const stub = {
		runIsolatedCheckPhase: vi.fn(async (request: Record<string, unknown>) => {
			phaseRequests.push(request)
			return request.phase === 'typecheck'
				? { ok: true, message: 'No semantic diagnostics (isolated).' }
				: { ok: true, message: 'chunk ok' }
		}),
	}
	const kv = {
		put: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	}
	const namespace = {
		idFromName: vi.fn((name: string) => ({ name })),
		get: vi.fn(() => stub),
	}
	const env = {
		REPO_SESSION: namespace,
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
		env,
		baseUrl: '/',
		userId: 'user-123',
	})

	expect(result.ok).toBe(true)
	// The staged snapshot is written once with a TTL and cleaned up after.
	expect(kv.put).toHaveBeenCalledTimes(1)
	const [stagingKey, stagedBody, stagedOptions] = kv.put.mock.calls[0] as [
		string,
		string,
		{ expirationTtl: number },
	]
	expect(stagingKey.startsWith('repo-checks-staging:v1:user-123:')).toBe(true)
	expect(JSON.parse(stagedBody).sourceFiles['src/a.ts']).toContain(
		'export default',
	)
	expect(stagedOptions.expirationTtl).toBeGreaterThan(0)
	expect(kv.delete).toHaveBeenCalledWith(stagingKey)

	// The language service and bundlers never run in this isolate.
	expect(mockModule.createTypescriptLanguageService).not.toHaveBeenCalled()
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()

	// One typecheck phase plus ceil(targets / chunk) bundle chunks, each in a
	// fresh throwaway isolate.
	const typecheckRequests = phaseRequests.filter(
		(request) => request.phase === 'typecheck',
	)
	expect(typecheckRequests).toHaveLength(1)
	expect(typecheckRequests[0]).toMatchObject({ userId: 'user-123' })
	// Throwaway isolate ids are namespaced by the requesting user.
	for (const [name] of namespace.idFromName.mock.calls) {
		expect(name as string).toContain('-user-123-')
	}
	const bundleRequests = phaseRequests.filter(
		(request) => request.phase === 'bundle-chunk',
	)
	const chunkSizes = bundleRequests.map(
		(request) => (request.bundleTargets as Array<unknown>).length,
	)
	const totalTargets = chunkSizes.reduce((sum, size) => sum + size, 0)
	expect(totalTargets).toBeGreaterThanOrEqual(6)
	expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(isolatedBundleChunkSize)
	expect(bundleRequests.length).toBe(
		Math.ceil(totalTargets / isolatedBundleChunkSize),
	)
	const distinctIsolateNames = new Set(
		namespace.idFromName.mock.calls.map(([name]) => name as string),
	)
	expect(distinctIsolateNames.size).toBe(phaseRequests.length)

	const bundleResult = result.results.find((entry) => entry.kind === 'bundle')
	expect(bundleResult).toMatchObject({
		ok: true,
		message: `Bundled ${totalTargets} package target(s) successfully.`,
	})
	const typecheckResult = result.results.find(
		(entry) => entry.kind === 'typecheck',
	)
	expect(typecheckResult).toMatchObject({
		ok: true,
		message: 'No semantic diagnostics (isolated).',
	})
})

test('an isolate reset during a check phase becomes a failed check, not a crash', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/oversized-package',
				kodyId: 'oversized-package',
				description: 'Package whose bundle phase exceeds isolate limits',
			}),
		],
		[
			'src/index.ts',
			`export default async function main() {\n\treturn 'ok'\n}\n`,
		],
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

	const stub = {
		runIsolatedCheckPhase: vi.fn(async (request: { phase: string }) => {
			if (request.phase === 'bundle-chunk') {
				throw new Error(
					"Durable Object's isolate exceeded its memory limit and was reset.",
				)
			}
			return { ok: true, message: 'No semantic diagnostics (isolated).' }
		}),
	}
	const env = {
		REPO_SESSION: {
			idFromName: vi.fn((name: string) => ({ name })),
			get: vi.fn(() => stub),
		},
		BUNDLE_ARTIFACTS_KV: {
			put: vi.fn(async () => undefined),
			delete: vi.fn(async () => undefined),
		},
	} as unknown as Env

	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
		env,
		baseUrl: '/',
		userId: 'user-123',
	})

	expect(result.ok).toBe(false)
	const bundleResult = result.results.find((entry) => entry.kind === 'bundle')
	expect(bundleResult?.ok).toBe(false)
	expect(bundleResult?.message).toContain(
		"exceeded the isolated check runner's",
	)
})
