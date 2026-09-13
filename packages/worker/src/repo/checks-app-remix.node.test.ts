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
		userId: 'user-123',
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

test('runRepoChecks reports the declared Remix runtime for kody.app.entry', async () => {
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
	expect(result.ok).toBe(true)
	const bundle = result.results.find((entry) => entry.kind === 'bundle')
	expect(bundle?.message).toBe(
		'Bundled 3 package target(s) successfully. kody.app.entry "app/router.ts" uses the remix runtime.',
	)
})

test('runRepoChecks infers the Remix runtime from remix imports and says how to pin it', async () => {
	const result = await runChecks(
		new Map([
			['package.json', createManifest({ app: { entry: './app/router.ts' } })],
			...remixAppFiles,
		]),
	)
	expect(result.ok).toBe(true)
	const bundle = result.results.find((entry) => entry.kind === 'bundle')
	expect(bundle?.message).toContain(
		'kody.app.entry "app/router.ts" uses the remix runtime (inferred; set kody.app.runtime to pin it).',
	)
})

test('runRepoChecks keeps a plain fetch handler on the fetch runtime', async () => {
	const result = await runChecks(
		new Map([
			['package.json', createManifest({ app: { entry: './src/app.ts' } })],
			['src/index.ts', 'export default async () => ({ ready: true })\n'],
			[
				'src/app.ts',
				'export default { async fetch() { return new Response("ok") } }\n',
			],
		]),
	)
	expect(result.ok).toBe(true)
	const bundle = result.results.find((entry) => entry.kind === 'bundle')
	expect(bundle?.message).toContain(
		'kody.app.entry "src/app.ts" uses the fetch runtime',
	)
})

test('runRepoChecks rejects @remix-run/* npm dependencies and points at remix/<subpath>', async () => {
	const result = await runChecks(
		new Map([
			[
				'package.json',
				createManifest({
					app: { runtime: 'remix', entry: './app/router.ts' },
					dependencies: {
						'@remix-run/fetch-router': '^0.22.0',
						zod: '^4.0.0',
					},
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
	expect(dependencies?.message).toBe(
		'package.json#dependencies must not list "@remix-run/fetch-router": import Remix as "remix/<subpath>" (for example "remix/router", "remix/ui"); Kody supplies that package to every bundle, and a second copy from npm would not share its component runtime.',
	)
	expect(result.results.some((entry) => entry.kind === 'bundle')).toBe(false)
	expect(mockModule.buildKodyAppBundle).not.toHaveBeenCalled()
})

test('runRepoChecks treats a types-only remix devDependency as no npm dependency at all', async () => {
	const result = await runChecks(
		new Map([
			[
				'package.json',
				createManifest({
					app: { runtime: 'remix', entry: './app/router.ts' },
					devDependencies: { remix: '3.0.0-rc.2', typescript: '^6.0.0' },
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
		'package.json declares no npm dependencies.',
	)
	// The bundle path receives the manifest untouched; publish never installs
	// devDependencies, so the platform copy of remix is the only one.
	expect(mockModule.buildKodyAppBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'app/router.ts' }),
	)
})

test('runRepoChecks notes that a declared remix dependency is not installed', async () => {
	const result = await runChecks(
		new Map([
			[
				'package.json',
				createManifest({
					app: { runtime: 'remix', entry: './app/router.ts' },
					dependencies: { remix: '3.0.0-rc.2' },
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
		'Kody supplies "remix" to every package bundle at the platform version, so the declared range is not installed.',
	)
})
