import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	createFileSystemSnapshot: vi.fn(),
	createTypescriptLanguageService: vi.fn(),
	buildKodyAppBundle: vi.fn(),
	buildKodyAppClientBundle: vi.fn(),
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
	buildKodyAppClientBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyAppClientBundle(...args),
	buildKodyImportableModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyImportableModuleBundle(...args),
	buildKodyModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyModuleBundle(...args),
}))

import { runRepoChecks } from './checks.ts'
import { withRequiredPackageDocs } from './checks-test-docs.ts'

function createAppManifest(app: Record<string, string>) {
	return JSON.stringify({
		name: '@kody/client-app',
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'client-app',
			description: 'App with a platform-built browser client',
			app,
		},
	})
}

function setupBundleMocks() {
	mockModule.buildKodyAppBundle.mockReset()
	mockModule.buildKodyAppClientBundle.mockReset()
	mockModule.buildKodyModuleBundle.mockReset()
	mockModule.buildKodyImportableModuleBundle.mockReset()
	mockModule.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: { 'dist/app.js': 'export default { fetch() {} }' },
		dependencies: [],
	})
	mockModule.buildKodyAppClientBundle.mockResolvedValue({
		mainModule: 'client.0123456789abcdef.js',
		modules: { 'client.0123456789abcdef.js': 'console.log("hi")' },
		dependencies: [],
	})
	mockModule.buildKodyModuleBundle.mockResolvedValue({
		mainModule: 'dist/module.js',
		modules: { 'dist/module.js': 'export default async () => "ok"' },
		dependencies: [],
	})
	mockModule.buildKodyImportableModuleBundle.mockResolvedValue({
		mainModule: 'dist/importable.js',
		modules: { 'dist/importable.js': 'export const ready = true' },
		dependencies: [],
	})
}

async function runChecks(files: Map<string, string>) {
	setupBundleMocks()
	withRequiredPackageDocs(files)
	const snapshot = {
		read: vi.fn((path: string) => files.get(path) ?? null),
	}
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: { ...snapshot, write: vi.fn() },
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	return await runRepoChecks({
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
}

const baseFiles: Array<[string, string]> = [
	['src/index.ts', 'export default async () => ({ ready: true })\n'],
	[
		'src/app.ts',
		'export default { async fetch() { return new Response("ok") } }\n',
	],
	['src/client.ts', 'document.body.textContent = "hi"\n'],
	['public/styles.css', 'body { color: red }\n'],
]

test('runRepoChecks bundles kody.app.client for the browser alongside the Worker entry', async () => {
	const result = await runChecks(
		new Map([
			[
				'package.json',
				createAppManifest({
					entry: './src/app.ts',
					client: './src/client.ts',
					assets: './public',
				}),
			],
			...baseFiles,
		]),
	)

	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'bundle', ok: true }),
		]),
	)
	expect(mockModule.buildKodyAppBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/app.ts' }),
	)
	expect(mockModule.buildKodyAppClientBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/client.ts' }),
	)
	expect(mockModule.buildKodyAppClientBundle).toHaveBeenCalledTimes(1)
})

test('runRepoChecks reports a missing kody.app.client entry as a bundle failure', async () => {
	const result = await runChecks(
		new Map([
			[
				'package.json',
				createAppManifest({
					entry: './src/app.ts',
					client: './src/missing-client.ts',
				}),
			],
			...baseFiles,
		]),
	)

	expect(result.ok).toBe(false)
	const bundle = result.results.find((entry) => entry.kind === 'bundle')
	expect(bundle?.ok).toBe(false)
	expect(bundle?.message).toContain('src/missing-client.ts')
	expect(mockModule.buildKodyAppClientBundle).not.toHaveBeenCalled()
})

test('runRepoChecks surfaces browser bundle errors from the client build', async () => {
	setupBundleMocks()
	const files = new Map([
		[
			'package.json',
			createAppManifest({ entry: './src/app.ts', client: './src/client.ts' }),
		],
		...baseFiles,
	])
	withRequiredPackageDocs(files)
	const snapshot = {
		read: vi.fn((path: string) => files.get(path) ?? null),
	}
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: { ...snapshot, write: vi.fn() },
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	mockModule.buildKodyAppClientBundle.mockRejectedValue(
		new Error(
			'Saved package app client "src/client.ts" bundle imports server-only modules that cannot run in the browser (src/client.ts: "kody:runtime").',
		),
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
	const bundle = result.results.find((entry) => entry.kind === 'bundle')
	expect(bundle?.ok).toBe(false)
	expect(bundle?.message).toContain('src/client.ts: ')
	expect(bundle?.message).toContain('kody:runtime')
})

test('runRepoChecks rejects a kody.app.assets directory with no files or an unsafe root', async () => {
	const empty = await runChecks(
		new Map([
			[
				'package.json',
				createAppManifest({ entry: './src/app.ts', assets: './static' }),
			],
			...baseFiles,
		]),
	)
	expect(empty.ok).toBe(false)
	expect(empty.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringContaining('no files exist under that directory'),
			}),
		]),
	)
	expect(mockModule.buildKodyAppBundle).not.toHaveBeenCalled()

	const root = await runChecks(
		new Map([
			[
				'package.json',
				createAppManifest({ entry: './src/app.ts', assets: '.' }),
			],
			...baseFiles,
		]),
	)
	expect(root.ok).toBe(false)
	expect(root.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringContaining('must name a subdirectory'),
			}),
		]),
	)
})

test('runRepoChecks leaves apps without kody.app.client on the Worker-only path', async () => {
	const result = await runChecks(
		new Map([
			['package.json', createAppManifest({ entry: './src/app.ts' })],
			...baseFiles,
		]),
	)

	expect(result.ok).toBe(true)
	expect(mockModule.buildKodyAppBundle).toHaveBeenCalledTimes(1)
	expect(mockModule.buildKodyAppClientBundle).not.toHaveBeenCalled()
})
