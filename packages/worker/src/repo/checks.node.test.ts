import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	createFileSystemSnapshot: vi.fn(),
	createTypescriptLanguageService: vi.fn(),
}))

vi.mock('@cloudflare/worker-bundler', () => ({
	createFileSystemSnapshot: (...args: Array<unknown>) =>
		mockModule.createFileSystemSnapshot(...args),
}))

vi.mock('@cloudflare/worker-bundler/typescript', () => ({
	createTypescriptLanguageService: (...args: Array<unknown>) =>
		mockModule.createTypescriptLanguageService(...args),
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
		},
	})
}

test('runRepoChecks normalizes leading slashes in package job entrypoints', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
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
				message: 'Resolved 2 package runtime entrypoint(s) for bundling.',
			}),
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message: 'No semantic diagnostics for 2 package runtime entrypoint(s).',
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
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
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
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
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
				message: 'package.json found for dependency fingerprinting.',
			}),
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message: 'No semantic diagnostics for 2 package runtime entrypoint(s).',
			}),
		]),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const storage'),
	)
})

test('runRepoChecks typechecks package exports with execute semantics globals', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/runtime-globals-export',
				kodyId: 'runtime-globals-export',
				description: 'Uses execute globals',
				exports: {
					'.': './src/index.ts',
					'./run': './src/run.ts',
				},
			}),
		],
		['src/index.ts', 'export const ready = true\n'],
		[
			'src/run.ts',
			`async (params) => {
  const result = await codemode.value_get({ name: 'projectId' })
  return { params, result }
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
				kind: 'typecheck',
				ok: true,
				message: 'No semantic diagnostics for 2 package runtime entrypoint(s).',
			}),
		]),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const codemode'),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('declare function __kodyTypecheckModule'),
	)
	expect(typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		'.__kody_repo_runtime__.d.ts',
		expect.stringContaining('declare const storage'),
	)
})

test('runRepoChecks still reports unknown globals for package-owned jobs', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
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
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
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
				message: 'No semantic diagnostics for 2 package runtime entrypoint(s).',
			}),
		]),
	)
	expect(typeScriptFileSystem.write).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
		expect.stringContaining('import userEntrypoint from "./src/job"'),
	)
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(
		'.__kody_repo_module_check__.ts',
	)
})

test('runRepoChecks injects a synthetic tsconfig that allows optional .ts imports for package entrypoints', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
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
		expect.stringContaining('import userEntrypoint from "./src/index"'),
	)
})

test('runRepoChecks preserves repo tsconfig via extends while enabling optional .ts imports for packages', async () => {
	mockModule.createFileSystemSnapshot.mockReset()
	mockModule.createTypescriptLanguageService.mockReset()
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
		expect.stringContaining('import userEntrypoint from "./src/index"'),
	)
})
