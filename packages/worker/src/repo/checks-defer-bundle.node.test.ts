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

import { runRepoChecks } from './checks.ts'
import { type PublishPhaseTimings } from './publish-phase-timing.ts'

type MockSnapshot = {
	read: ReturnType<typeof vi.fn>
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

test('runRepoChecks defers full esbuild when rebuild will validate the same targets', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/deferred-bundle',
				kodyId: 'deferred-bundle',
				description: 'Skips check-time esbuild before artifact rebuild',
				exports: {
					'.': './src/index.ts',
					'./helper': './src/helper.ts',
				},
				appEntry: 'src/app.ts',
				jobs: {
					digest: {
						entry: 'src/job.ts',
						schedule: {
							type: 'once',
							runAt: '2026-04-17T15:00:00Z',
						},
					},
				},
			}),
		],
		['src/index.ts', 'export default async () => ({ ready: true })\n'],
		['src/helper.ts', 'export const ready = true\n'],
		[
			'src/app.ts',
			'export default { async fetch() { return new Response("ok") } }\n',
		],
		['src/job.ts', 'export default async () => ({ ok: true })\n'],
	])
	const snapshot = createSnapshotFromFiles(files)
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: {
			...snapshot,
			write: vi.fn(),
		},
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics,
		},
	})

	const phaseTimings: PublishPhaseTimings = {}
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
		phaseTimings,
		deferBundleCheckToRebuild: true,
	})

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: true,
				message: 'Bundle validation deferred to published artifact rebuild.',
			}),
			expect.objectContaining({ kind: 'typecheck', ok: true }),
		]),
	)
	expect(phaseTimings).toEqual({
		checks_typecheck_ms: expect.any(Number),
	})
	expect(phaseTimings.checks_bundle_ms).toBeUndefined()
	expect(mockModule.buildKodyAppBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyImportableModuleBundle).not.toHaveBeenCalled()
	expect(getSemanticDiagnostics).toHaveBeenCalled()

	mockModule.buildKodyAppBundle.mockClear()
	mockModule.buildKodyModuleBundle.mockClear()
	mockModule.buildKodyImportableModuleBundle.mockClear()
	const missingFiles = new Map(files)
	missingFiles.delete('src/helper.ts')
	const missingSnapshot = createSnapshotFromFiles(missingFiles)
	mockModule.createFileSystemSnapshot.mockResolvedValue(missingSnapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: {
			...missingSnapshot,
			write: vi.fn(),
		},
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	const missingTimings: PublishPhaseTimings = {}
	const missingResult = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return missingFiles.get(path) ?? null
			},
			async glob() {
				return Array.from(missingFiles.keys()).map((path) => ({
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
		phaseTimings: missingTimings,
		deferBundleCheckToRebuild: true,
	})
	expect(missingResult.ok).toBe(false)
	expect(missingResult.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringContaining('src/helper.ts'),
			}),
		]),
	)
	expect(missingTimings.checks_bundle_ms).toBeUndefined()
	expect(mockModule.buildKodyAppBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyImportableModuleBundle).not.toHaveBeenCalled()
})

test('deferred bundle check still typechecks in an isolate and does not start bundle-chunk isolates', async () => {
	setupDefaultBundleMocks()
	const files = new Map<string, string>([
		[
			'package.json',
			createPackageManifest({
				packageName: '@kody/deferred-isolated-bundle',
				kodyId: 'deferred-isolated-bundle',
				description: 'Typecheck isolate only when bundle check is deferred',
				exports: {
					'.': './src/a.ts',
					'./b': './src/b.ts',
					'./c': './src/c.ts',
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
			}),
		],
		['src/a.ts', 'export default async () => ({ a: true })\n'],
		['src/b.ts', 'export default async () => ({ b: true })\n'],
		['src/c.ts', 'export default async () => ({ c: true })\n'],
		['src/job.ts', 'export default async () => ({ ok: true })\n'],
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
	const phaseTimings: PublishPhaseTimings = {}

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
		phaseTimings,
		deferBundleCheckToRebuild: true,
	})

	expect(result.ok).toBe(true)
	expect(phaseRequests.map((request) => request.phase)).toEqual(['typecheck'])
	expect(stub.runIsolatedCheckPhase).toHaveBeenCalledTimes(1)
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyImportableModuleBundle).not.toHaveBeenCalled()
	expect(phaseTimings.checks_typecheck_ms).toEqual(expect.any(Number))
	expect(phaseTimings.checks_bundle_ms).toBeUndefined()
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: true,
				message: 'Bundle validation deferred to published artifact rebuild.',
			}),
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message: 'No semantic diagnostics (isolated).',
			}),
		]),
	)
})
