import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
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

function createManifest(input: {
	app: Record<string, string>
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}) {
	return JSON.stringify({
		name: '@kody/remix-app',
		exports: { '.': './src/index.ts' },
		...(input.dependencies ? { dependencies: input.dependencies } : {}),
		...(input.devDependencies
			? { devDependencies: input.devDependencies }
			: {}),
		kody: {
			id: 'remix-app',
			description: 'Remix mini-app',
			app: input.app,
		},
	})
}

async function runChecks(files: Map<string, string>) {
	for (const build of [
		mockModule.buildKodyAppBundle,
		mockModule.buildKodyAppClientBundle,
		mockModule.buildKodyModuleBundle,
		mockModule.buildKodyImportableModuleBundle,
	]) {
		build.mockReset()
		build.mockResolvedValue({
			mainModule: 'dist/out.js',
			modules: { 'dist/out.js': 'export default {}' },
			dependencies: [],
		})
	}
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
		userId: ownerIdFromStored('user-123'),
	})
}

const remixAppFiles: Array<[string, string]> = [
	['src/index.ts', 'export default async () => ({ ready: true })\n'],
	[
		'app/router.ts',
		[
			"import { createRouter } from 'remix/router'",
			"import { routes } from './routes.ts'",
			'const router = createRouter()',
			"router.map(routes.home, () => new Response('home'))",
			'export default router',
		].join('\n'),
	],
	[
		'app/routes.ts',
		"import { route } from 'remix/routes'\nexport const routes = route({ home: '/' })",
	],
]

test('runRepoChecks rejects kody.app.runtime as a removed option', async () => {
	const result = await runChecks(
		new Map([
			[
				'package.json',
				createManifest({
					app: { runtime: 'remix', entry: './app/router.ts' },
				}),
			],
			...remixAppFiles,
		]),
	)
	expect(result.ok).toBe(false)
	const manifest = result.results.find((entry) => entry.kind === 'manifest')
	expect(manifest?.ok).toBe(false)
	expect(manifest?.message).toMatch(/kody\.app\.runtime was removed/)
	expect(result.results.some((entry) => entry.kind === 'bundle')).toBe(false)
	expect(mockModule.buildKodyAppBundle).not.toHaveBeenCalled()
})

test('runRepoChecks bundles a router app and a fetch handler without a runtime field', async () => {
	const remixResult = await runChecks(
		new Map([
			[
				'package.json',
				createManifest({
					app: { entry: './app/router.ts' },
					dependencies: { remix: '3.0.0' },
				}),
			],
			...remixAppFiles,
		]),
	)
	expect(remixResult.ok).toBe(true)
	const remixBundle = remixResult.results.find(
		(entry) => entry.kind === 'bundle',
	)
	expect(remixBundle?.message).toBe('Bundled 3 package target(s) successfully.')

	const fetchResult = await runChecks(
		new Map([
			['package.json', createManifest({ app: { entry: './src/app.ts' } })],
			['src/index.ts', 'export default async () => ({ ready: true })\n'],
			[
				'src/app.ts',
				'export default { async fetch() { return new Response("ok") } }\n',
			],
		]),
	)
	expect(fetchResult.ok).toBe(true)
	const fetchBundle = fetchResult.results.find(
		(entry) => entry.kind === 'bundle',
	)
	expect(fetchBundle?.message).toBe('Bundled 3 package target(s) successfully.')
})

test('runRepoChecks treats remix and @remix-run/* as ordinary npm dependencies', async () => {
	const result = await runChecks(
		new Map([
			[
				'package.json',
				createManifest({
					app: { entry: './app/router.ts' },
					dependencies: {
						'@remix-run/ui': '0.12.1',
						remix: '3.0.0',
						zod: '^4.0.0',
					},
				}),
			],
			...remixAppFiles,
		]),
	)
	expect(result.ok).toBe(true)
	const dependencies = result.results.find(
		(entry) => entry.kind === 'dependencies',
	)
	expect(dependencies?.ok).toBe(true)
	expect(dependencies?.message).toContain(
		'package.json declares 3 npm dependencies: "@remix-run/ui", "remix", "zod".',
	)
	expect(mockModule.buildKodyAppBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'app/router.ts' }),
	)
})

test('runRepoChecks fails when remix is only a types-only devDependency', async () => {
	// Publish installs dependencies only; a types-only remix in
	// devDependencies never reaches the bundle snapshot, so a runtime import
	// of remix must fail the dependencies check (not silently publish).
	const result = await runChecks(
		new Map([
			[
				'package.json',
				createManifest({
					app: { entry: './app/router.ts' },
					devDependencies: { remix: '3.0.0', typescript: '^6.0.0' },
				}),
			],
			...remixAppFiles,
		]),
	)
	expect(result.ok).toBe(false)
	const dependencies = result.results.find(
		(entry) => entry.kind === 'dependencies',
	)
	expect(dependencies?.ok).toBe(false)
	expect(dependencies?.message).toContain(
		'package.json declares no npm dependencies.',
	)
	expect(dependencies?.message).toMatch(/undeclared bare package\(s\): "remix"/)
})
