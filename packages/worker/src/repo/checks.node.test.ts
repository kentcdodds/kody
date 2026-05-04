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

beforeEach(() => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
	mockModule.buildKodyAppBundle.mockReset()
	mockModule.buildKodyImportableModuleBundle.mockReset()
	mockModule.buildKodyModuleBundle.mockReset()
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
	exports?: Record<string, string>
	jobs?: Record<string, { entry: string; schedule: Record<string, unknown> }>
	subscriptions?: Record<
		string,
		{ handler: string; description?: string; filters?: Record<string, unknown> }
	>
	services?: Record<string, { entry: string }>
	workflows?: Record<string, { export: string; description?: string }>
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
			app: input.appEntry
				? {
						entry: input.appEntry,
					}
				: undefined,
			jobs: input.jobs,
			subscriptions: input.subscriptions,
			services: input.services,
			workflows: input.workflows,
			retrievers: input.retrievers,
		},
	})
}

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
		['src/job.ts', 'async () => ({ ok: true })\n'],
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
		['/session/src/job.ts', 'async () => ({ ok: true })\n'],
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
			`async (params) => {
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
				message: 'package.json declares no npm dependencies.',
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
					'./workflow': './src/workflow.ts',
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
				workflows: {
					refresh: {
						export: './workflow',
						description: 'Refreshes derived data.',
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
		['src/workflow.ts', 'export default async (params) => params\n'],
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
					'No semantic diagnostics for 4 callable package runtime entrypoint(s).',
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
		expect.stringContaining('import userEntrypoint from "./src/workflow"'),
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
		['src/job.ts', 'async () => totallyMissingThing()\n'],
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
	expect(typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/index"'),
	)
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
	)
})

test('runRepoChecks injects a synthetic tsconfig that allows optional .ts imports for package entrypoints', async () => {
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
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
			}),
		],
		['src/index.ts', 'export const ready = true\n'],
		['src/job.ts', 'export { default } from "./helper.ts"\n'],
		['src/helper.ts', 'export default async () => ({ ok: true })\n'],
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
	expect(mockModule.createTypescriptLanguageService).toHaveBeenCalledWith({
		fileSystem: expect.objectContaining({
			read: expect.any(Function),
			write: expect.any(Function),
			delete: expect.any(Function),
			list: expect.any(Function),
			flush: expect.any(Function),
		}),
	})
	const typecheckInput = mockModule.createTypescriptLanguageService.mock
		.calls[0]?.[0] as { fileSystem: MockTypeScriptFileSystem }
	expect(typecheckInput.fileSystem.read('tsconfig.json')).toBe(
		JSON.stringify({
			compilerOptions: {
				allowImportingTsExtensions: true,
				noEmit: true,
			},
		}),
	)
	expect(
		typecheckInput.fileSystem.read('./.__kody_repo_tsconfig_base__.json'),
	).toBe(null)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/job"'),
	)
	expect(typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/index"'),
	)
})

test('runRepoChecks preserves repo tsconfig via extends while enabling optional .ts imports for packages', async () => {
	const repoTsconfig = JSON.stringify({
		compilerOptions: {
			module: 'NodeNext',
			moduleResolution: 'NodeNext',
			strict: true,
		},
	})
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/ts-extension-job',
				kodyId: 'ts-extension-job',
				description: 'Preserves repo tsconfig',
				jobs: {
					tsExtension: {
						entry: 'src/job.ts',
						schedule: {
							type: 'once',
							runAt: '2026-04-17T15:00:00Z',
						},
					},
				},
			}),
		],
		['tsconfig.json', repoTsconfig],
		['src/index.ts', 'export const ready = true\n'],
		['src/job.ts', 'export { default } from "./helper.ts"\n'],
		['src/helper.ts', 'export default async () => ({ ok: true })\n'],
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
	const typecheckInput = mockModule.createTypescriptLanguageService.mock
		.calls[0]?.[0] as { fileSystem: MockTypeScriptFileSystem }
	expect(typecheckInput.fileSystem.read('tsconfig.json')).toBe(
		JSON.stringify({
			extends: './.__kody_repo_tsconfig_base__.json',
			compilerOptions: {
				allowImportingTsExtensions: true,
				noEmit: true,
			},
		}),
	)
	expect(
		typecheckInput.fileSystem.read('.__kody_repo_tsconfig_base__.json'),
	).toBe(repoTsconfig)
	expect(
		typecheckInput.fileSystem.read('/.__kody_repo_tsconfig_base__.json'),
	).toBe(repoTsconfig)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/job"'),
	)
	expect(typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/index"'),
	)
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
				message: 'package.json declares 1 npm dependency: "kleur".',
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
				message: 'package.json declares 1 npm dependency: "marked".',
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
