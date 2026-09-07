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

function createSnapshotFromFiles(files: Map<string, string>) {
	return {
		read: vi.fn((path: string) => files.get(path) ?? null),
	}
}

function createPackageManifest() {
	return JSON.stringify({
		name: '@kody/docs-missing',
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'docs-missing',
			description: 'Missing required package docs',
		},
	})
}

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
	mockModule.createFileSystemSnapshot.mockResolvedValue(
		createSnapshotFromFiles(new Map()),
	)

	const missingBoth = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return path === 'package.json'
					? createPackageManifest()
					: path === 'src/index.ts'
						? 'export const ready = true\n'
						: null
			},
			async glob() {
				return [
					{ path: 'package.json', type: 'file' },
					{ path: 'src/index.ts', type: 'file' },
				]
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
	})
	expect(missingBoth.ok).toBe(false)
	expect(missingBoth.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'docs',
				ok: false,
				message: expect.stringContaining('README.md and AGENTS.md'),
			}),
		]),
	)

	const files = new Map<string, string>([
		['package.json', createPackageManifest()],
		['README.md', '   \n'],
		['AGENTS.md', '# Agents\n\nSmoke-test the root export.\n'],
		['src/index.ts', 'export const ready = true\n'],
	])
	mockModule.createFileSystemSnapshot.mockResolvedValue(
		createSnapshotFromFiles(files),
	)
	const emptyReadme = await runRepoChecks({
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
	expect(emptyReadme.ok).toBe(false)
	expect(emptyReadme.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'docs',
				ok: false,
				message: expect.stringContaining('README.md is missing or empty'),
			}),
		]),
	)
})
