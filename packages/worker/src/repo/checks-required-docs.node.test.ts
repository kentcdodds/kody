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

const manifest = JSON.stringify({
	name: '@kody/docs-missing',
	exports: { '.': './src/index.ts' },
	kody: { id: 'docs-missing', description: 'Missing required package docs' },
})

test('runRepoChecks fails publish when root README.md or AGENTS.md is missing or empty', async () => {
	mockModule.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: { 'dist/app.js': 'export default {}' },
		dependencies: [],
	})
	mockModule.buildKodyModuleBundle.mockResolvedValue({
		mainModule: 'dist/module.js',
		modules: { 'dist/module.js': 'export default async function run() {}' },
		dependencies: [],
	})
	mockModule.buildKodyImportableModuleBundle.mockResolvedValue({
		mainModule: 'dist/importable.js',
		modules: { 'dist/importable.js': 'export const ready = true' },
		dependencies: [],
	})

	const cases: Array<[Record<string, string>, string]> = [
		[{}, 'README.md and AGENTS.md'],
		[
			{
				'README.md': '   \n',
				'AGENTS.md': '# Agents\n\nSmoke-test the root export.\n',
			},
			'README.md is missing or empty',
		],
	]
	for (const [docs, message] of cases) {
		const files = new Map(
			Object.entries({
				'package.json': manifest,
				...docs,
				'src/index.ts': 'export const ready = true\n',
			}),
		)
		mockModule.createFileSystemSnapshot.mockResolvedValue({
			read: vi.fn((path: string) => files.get(path) ?? null),
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
		expect([message, result.ok, result.results]).toEqual([
			message,
			false,
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'docs',
					ok: false,
					message: expect.stringContaining(message),
				}),
			]),
		])
	}
})
