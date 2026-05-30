import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	createFileSystemSnapshot: vi.fn(),
	createTypescriptLanguageService: vi.fn(),
	buildKodyAppBundle: vi.fn(),
	buildKodyImportableModuleBundle: vi.fn(),
	buildKodyModuleBundle: vi.fn(),
}))

vi.mock('@cloudflare/worker-bundler', () => ({
	createFileSystemSnapshot: (...args: Array<unknown>) =>
		mockModule.createFileSystemSnapshot(...args),
}))

vi.mock('@cloudflare/worker-bundler/typescript', () => ({
	createTypescriptLanguageService: (...args: Array<unknown>) =>
		mockModule.createTypescriptLanguageService(...args),
}))

vi.mock('#worker/package-runtime/module-graph.ts', () => ({
	buildKodyAppBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyAppBundle(...args),
	buildKodyImportableModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyImportableModuleBundle(...args),
	buildKodyModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyModuleBundle(...args),
}))

import { runRepoChecks } from './checks.ts'

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

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- restores shared default bundle mocks after global mockReset.
beforeEach(() => {
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
})

async function collectSnapshotFiles(
	input: AsyncIterable<readonly [string, string]>,
) {
	const snapshotFiles = new Map<string, string>()
	for await (const [path, content] of input) {
		snapshotFiles.set(path, content)
	}
	return snapshotFiles
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

test('runRepoChecks keeps non-code source files for publish snapshots while excluding git internals', async () => {
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

test('runRepoChecks normalizes leading slashes in package job entrypoints', async () => {
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/migrated-job',
				kodyId: 'migrated-job',
				description: 'Runs immediately after migration',
				exports: {
					'.': './src/index.ts',
				},
				jobs: {
					migrate: {
						entry: '/src/job.ts',
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

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: true,
				message: 'Resolved 2 package target(s) for bundling.',
			}),
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message:
					'No semantic diagnostics for 1 callable package runtime entrypoint(s).',
			}),
		]),
	)
	expect(snapshot.read).toHaveBeenCalledWith('src/index.ts')
	expect(snapshot.read).toHaveBeenCalledWith('src/job.ts')
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const codemode'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('declare function __kodyTypecheckModule'),
	)
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
	)
})

test('runRepoChecks strips repo-session workspace prefixes from package snapshot paths', async () => {
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

test('runRepoChecks accepts execute runtime globals for package-owned jobs', async () => {
	const files = new Map<string, string>([
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
  await codemode.value_get({ name: 'projectId' })
  await storage.get('count')
  return params
}
`,
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

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
				message:
					'package.json declares no npm dependencies. package.json#kody.dependencies declares no static Kody package dependencies.',
			}),
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message:
					'No semantic diagnostics for 1 callable package runtime entrypoint(s).',
			}),
		]),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const storage'),
	)
})

test('runRepoChecks constrains events.dispatch topics to package.json#kody.emits', async () => {
	const files = new Map<string, string>([
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
			getSemanticDiagnostics: vi.fn(() => []),
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

	expect(result.ok).toBe(true)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining(
			'type KodyDeclaredEventTopic = "@kentcdodds/discord.message.created";',
		),
	)
})

test('runRepoChecks allows named-only helper exports and typechecks callable manifest exports', async () => {
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/helper-and-callable-export',
				kodyId: 'helper-and-callable-export',
				description: 'Exports helpers and callable runtime targets',
				exports: {
					'.': './src/index.ts',
					'./helper': './src/helper.ts',
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
		['src/index.ts', 'export const ready = true\n'],
		[
			'src/helper.ts',
			'export const format = (value: string) => value.trim()\n',
		],
		[
			'src/job.ts',
			`export default async (params) => {
  const result = await codemode.value_get({ name: 'projectId' })
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

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message:
					'No semantic diagnostics for 3 callable package runtime entrypoint(s).',
			}),
		]),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const codemode'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/job"'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/search"'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/subscription"'),
	)
	expect(typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/helper"'),
	)
})

test('runRepoChecks still reports unknown globals for package-owned jobs', async () => {
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

test('runRepoChecks rejects legacy async-arrow package job entrypoints', async () => {
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/legacy-job',
				kodyId: 'legacy-job',
				description: 'Uses a legacy snippet entrypoint',
				jobs: {
					legacy: {
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
		['src/job.ts', 'async () => ({ ok: true })\n'],
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

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
					'Repo-backed package export entrypoints and job entrypoints must default export a function',
				),
			}),
		]),
	)
	expect(mockModule.createTypescriptLanguageService).not.toHaveBeenCalled()
})

test('runRepoChecks rejects named-only callable package entrypoints', async () => {
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/named-only-job',
				kodyId: 'named-only-job',
				description: 'Uses a named export for a callable entrypoint',
				jobs: {
					named: {
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
		['src/job.ts', 'export const run = async () => ({ ok: true })\n'],
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

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
					'Missing default export in: "src/job.ts"',
				),
			}),
		]),
	)
	expect(mockModule.createTypescriptLanguageService).not.toHaveBeenCalled()
})

test('runRepoChecks typechecks ESM package job entrypoints', async () => {
	const files = new Map<string, string>([
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
	])
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	const getSemanticDiagnostics = vi.fn((path: string) =>
		path === '.__kody_repo_module_check__.ts'
			? []
			: [{ messageText: `unexpected diagnostics for ${path}` }],
	)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
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

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message:
					'No semantic diagnostics for 1 callable package runtime entrypoint(s).',
			}),
		]),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/job"'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('type KodyPackagesInvokeTarget ='),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('export const storage: KodyStorageRuntime;'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('export const email: KodyEmailRuntime;'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('export const workflows: KodyWorkflowsRuntime;'),
	)
	expect(typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/index"'),
	)
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
	)
})

test('runRepoChecks injects package tsconfig overlays that allow optional .ts imports', async () => {
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
	expect(syntheticTypecheckInput.fileSystem.read('tsconfig.json')).toBe(
		JSON.stringify({
			compilerOptions: {
				allowImportingTsExtensions: true,
				noEmit: true,
			},
		}),
	)
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
	expect(extendsTypecheckInput.fileSystem.read('tsconfig.json')).toBe(
		JSON.stringify({
			extends: './.__kody_repo_tsconfig_base__.json',
			compilerOptions: {
				allowImportingTsExtensions: true,
				noEmit: true,
			},
		}),
	)
	expect(
		extendsTypecheckInput.fileSystem.read('.__kody_repo_tsconfig_base__.json'),
	).toBe(repoTsconfig)

	for (const { typeScriptFileSystem } of [syntheticOnly, extendsRepoBase]) {
		expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
			'.__kody_repo_module_check__.ts',
			expect.stringContaining('import userEntrypoint from "./src/job"'),
		)
		expect(typeScriptFileSystem.write).not.toHaveBeenCalledWith(
			'.__kody_repo_module_check__.ts',
			expect.stringContaining('import userEntrypoint from "./src/index"'),
		)
	}
})

test('runRepoChecks reports declared npm dependencies in package.json', async () => {
	const files = new Map<string, string>([
		[
			'package.json',
			JSON.stringify({
				name: '@kody/dependency-aware-package',
				exports: {
					'.': './src/index.ts',
				},
				dependencies: {
					kleur: '^4.1.5',
				},
				kody: {
					id: 'dependency-aware-package',
					description: 'Uses npm dependencies',
				},
			}),
		],
		['src/index.ts', 'export default async () => "ok"\n'],
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
			getSemanticDiagnostics: vi.fn(() => []),
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

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
				message:
					'package.json declares 1 npm dependency: "kleur". package.json#kody.dependencies declares no static Kody package dependencies.',
			}),
		]),
	)
})

test('runRepoChecks requires static kody package imports to be declared', async () => {
	const files = new Map<string, string>([
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
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

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
				kind: 'dependencies',
				ok: false,
				message: expect.stringContaining(
					'package.json#kody.dependencies must match direct static kody:@ imports (missing "@kentcdodds/helper").',
				),
			}),
		]),
	)
})

test('runRepoChecks accepts declared static kody package imports and ignores type-only imports', async () => {
	const files = new Map<string, string>([
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
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

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

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
				message: expect.stringContaining(
					'package.json#kody.dependencies declares 1 static Kody package dependency: "@kentcdodds/helper".',
				),
			}),
		]),
	)
})

test('runRepoChecks ignores kody imports in declaration files', async () => {
	const files = new Map<string, string>([
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
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

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

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
				message: expect.stringContaining(
					'package.json#kody.dependencies declares no static Kody package dependencies.',
				),
			}),
		]),
	)
})

test('runRepoChecks requires mixed value export-from kody package imports to be declared', async () => {
	const files = new Map<string, string>([
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
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

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
				kind: 'dependencies',
				ok: false,
				message: expect.stringContaining('missing "@kentcdodds/runner"'),
			}),
		]),
	)
})

test('runRepoChecks does not require current-resolved literal dynamic kody package imports to be declared', async () => {
	const files = new Map<string, string>([
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
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

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

	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
			}),
		]),
	)
})

test('runRepoChecks rejects invalid static kody package dependency declarations', async () => {
	const files = new Map<string, string>([
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
	])

	await expect(
		runRepoChecks({
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
		}),
	).rejects.toThrow(
		'Static Kody package dependencies must be scoped package names like "@scope/package".',
	)
})

test('runRepoChecks rejects unused static kody package dependency declarations', async () => {
	const files = new Map<string, string>([
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
	])
	const snapshot = createSnapshotFromFiles(files)
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)

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
				kind: 'dependencies',
				ok: false,
				message: expect.stringContaining(
					'package.json#kody.dependencies must match direct static kody:@ imports (unused "@kentcdodds/unused").',
				),
			}),
		]),
	)
})

test('runRepoChecks fails bundle validation when runtime bundling cannot resolve a declared dependency', async () => {
	const files = new Map<string, string>([
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
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	mockModule.buildKodyImportableModuleBundle.mockRejectedValueOnce(
		new Error('No such module "marked" imported from bundle.js'),
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
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
})

test('runRepoChecks validates package runtime bundles with npm dependencies', async () => {
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
			expect.objectContaining({
				kind: 'dependencies',
				ok: true,
				message:
					'package.json declares 1 npm dependency: "marked". package.json#kody.dependencies declares no static Kody package dependencies.',
			}),
			expect.objectContaining({
				kind: 'bundle',
				ok: true,
				message: 'Bundled 2 package target(s) successfully.',
			}),
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

test('runRepoChecks fails when package runtime bundle cannot resolve npm dependency', async () => {
	const files = new Map<string, string>([
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
	const snapshot = createSnapshotFromFiles(files)
	const typeScriptFileSystem: MockTypeScriptFileSystem = {
		...snapshot,
		write: vi.fn(),
	}
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: {
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	mockModule.buildKodyImportableModuleBundle.mockRejectedValueOnce(
		new Error('Could not resolve version for marked@18.0.2'),
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
					'src/index.ts: Could not resolve version for marked@18.0.2',
				),
			}),
		]),
	)
})
