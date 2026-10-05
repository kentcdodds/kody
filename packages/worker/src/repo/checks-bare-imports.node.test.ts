import { expect, test, vi } from 'vitest'
import { assertBundleHasNoUnresolvedBareImports } from '#worker/package-runtime/module-graph-artifacts.ts'
import {
	isUndeclaredBarePackageImportFailure,
	validateBarePackageImportDeclarations,
} from '#worker/package-runtime/bare-package-import-declarations.ts'
import { isUserCodeError, UserCodeError } from '#worker/user-code-error.ts'
import { filterUserCodeErrorSentryEvent } from '#worker/sentry-options.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'

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
import { withRequiredPackageDocs } from './checks-test-docs.ts'

function manifest(
	id: string,
	kody: Record<string, unknown> = {},
	pkg: Record<string, unknown> = {},
) {
	return JSON.stringify({
		name: `@kody/${id}`,
		exports: { '.': './src/index.ts' },
		...pkg,
		kody: { id, description: `Test package ${id}`, ...kody },
	})
}

function packageFiles(
	packageJson: string,
	sources: Record<string, string> = {},
) {
	return new Map<string, string>([
		['package.json', packageJson],
		['src/index.ts', 'export const ready = true\n'],
		...Object.entries(sources),
	])
}

async function runChecks(
	files: Map<string, string>,
	options: Partial<Parameters<typeof runRepoChecks>[0]> = {},
) {
	for (const build of [
		mockModule.buildKodyAppBundle,
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
	const snapshotFiles = new Map(files)
	const snapshot = {
		read: vi.fn((path: string) => snapshotFiles.get(path) ?? null),
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
		...options,
	})
}

test('undeclared bare package imports fail the dependencies check even when bundle is deferred', async () => {
	const files = packageFiles(manifest('undeclared-remix'), {
		'src/index.ts':
			'import { Schema } from "remix/data-schema"\nexport default async () => Schema\n',
	})
	const result = await runChecks(files, {
		deferBundleCheckToRebuild: true,
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})
	expect(result.ok).toBe(false)
	const dependencies = result.results.find(
		(entry) => entry.kind === 'dependencies',
	)
	expect(dependencies?.ok).toBe(false)
	expect(dependencies?.message).toMatch(
		/undeclared bare package\(s\): "remix".*src\/index\.ts/,
	)
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyImportableModuleBundle).not.toHaveBeenCalled()
})

test('undeclared bare imports reached only through relative require still fail deferred checks', async () => {
	const files = packageFiles(manifest('require-helper-remix'), {
		'src/index.ts':
			'const helper = require("./helper.ts")\nexport default async () => helper.run()\n',
		'src/helper.ts':
			'import { Schema } from "remix/data-schema"\nexport function run() { return Schema }\n',
	})
	const result = await runChecks(files, {
		deferBundleCheckToRebuild: true,
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})
	expect(result.ok).toBe(false)
	const dependencies = result.results.find(
		(entry) => entry.kind === 'dependencies',
	)
	expect(dependencies?.ok).toBe(false)
	expect(dependencies?.message).toMatch(
		/undeclared bare package\(s\): "remix".*src\/index\.ts/,
	)
})

test('declared bare package imports pass the dependencies check', async () => {
	const files = packageFiles(
		manifest('declared-remix', {}, { dependencies: { remix: '3.0.0' } }),
		{
			'src/index.ts':
				'import { Schema } from "remix/data-schema"\nexport default async () => Schema\n',
		},
	)
	const result = await runChecks(files, {
		deferBundleCheckToRebuild: true,
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})
	expect(result.ok).toBe(true)
	const dependencies = result.results.find(
		(entry) => entry.kind === 'dependencies',
	)
	expect(dependencies?.ok).toBe(true)
	expect(dependencies?.message).toContain('"remix"')
	expect(dependencies?.message).toContain(
		'Package entry imports resolve from package.json#dependencies or vendored node_modules.',
	)
})

test('vendored node_modules packages count as resolvable without a package.json declaration', async () => {
	const files = packageFiles(manifest('vendored-remix'), {
		'src/index.ts':
			'import { Schema } from "remix/data-schema"\nexport default async () => Schema\n',
		'node_modules/remix/package.json': JSON.stringify({
			name: 'remix',
			version: '3.0.0',
		}),
	})
	const result = await runChecks(files, {
		deferBundleCheckToRebuild: true,
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: 'user-123',
	})
	expect(result.ok).toBe(true)
	expect(
		result.results.find((entry) => entry.kind === 'dependencies')?.ok,
	).toBe(true)
})

test('validateBarePackageImportDeclarations skips client externals for client entries only', () => {
	const manifestJson = {
		name: '@kody/client-externals',
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'client-externals',
			description: 'Client externals package',
			app: {
				entry: './src/app.ts',
				client: { entry: './src/client.ts', externals: ['lit'] },
			},
		},
	} as AuthoredPackageJson
	const sourceFiles = {
		'package.json': JSON.stringify(manifestJson),
		'src/index.ts': 'export const ready = true\n',
		'src/app.ts':
			'export default { async fetch() { return new Response("ok") } }\n',
		'src/client.ts':
			'import { LitElement } from "lit"\nexport { LitElement }\n',
	}
	const clientOnly = validateBarePackageImportDeclarations({
		manifest: manifestJson,
		sourceFiles,
		entryPoints: [{ path: 'src/client.ts', bundleKind: 'client' }],
	})
	expect(clientOnly.ok).toBe(true)

	const serverEntry = validateBarePackageImportDeclarations({
		manifest: manifestJson,
		sourceFiles,
		entryPoints: [{ path: 'src/client.ts', bundleKind: 'callable' }],
	})
	expect(serverEntry.ok).toBe(false)
	expect(serverEntry.message).toMatch(/undeclared bare package\(s\): "lit"/)
})

test('assertBundleHasNoUnresolvedBareImports throws UserCodeError only for undeclared packages', () => {
	const modules = {
		'bundle.js':
			'import { Schema } from "remix/data-schema"\nexport { Schema }\n',
	}
	expect(() =>
		assertBundleHasNoUnresolvedBareImports({
			modules,
			bundleLabel: 'Saved package module "src/index.ts" bundle',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kody/x',
					exports: { '.': './src/index.ts' },
				}),
				'src/index.ts': 'export const ready = true\n',
			},
		}),
	).toThrow(UserCodeError)

	try {
		assertBundleHasNoUnresolvedBareImports({
			modules,
			bundleLabel: 'Saved package module "src/index.ts" bundle',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kody/x',
					dependencies: { remix: '3.0.0' },
					exports: { '.': './src/index.ts' },
				}),
				'src/index.ts': 'export const ready = true\n',
			},
		})
		throw new Error('expected throw')
	} catch (error) {
		expect(error).toBeInstanceOf(Error)
		expect(error).not.toBeInstanceOf(UserCodeError)
		expect(isUserCodeError(error)).toBe(false)
		expect(String(error)).toMatch(/unresolved bare package imports/)
	}
})

test('isUndeclaredBarePackageImportFailure distinguishes declared install failures', () => {
	expect(
		isUndeclaredBarePackageImportFailure({
			unresolvedSpecifiers: ['remix/data-schema'],
			sourceFiles: {
				'package.json': JSON.stringify({ name: '@kody/x' }),
			},
		}),
	).toBe(true)
	expect(
		isUndeclaredBarePackageImportFailure({
			unresolvedSpecifiers: ['remix/data-schema'],
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kody/x',
					dependencies: { remix: '3.0.0' },
				}),
			},
		}),
	).toBe(false)
})

test('Sentry beforeSend drops undeclared bare-import UserCodeError and keeps declared failures', () => {
	const userEvent = {
		type: undefined,
		message: 'unresolved bare package imports',
		exception: { values: [{ type: 'UserCodeError', value: 'undeclared' }] },
	}
	expect(
		filterUserCodeErrorSentryEvent(userEvent, {
			originalException: new UserCodeError(
				'Saved package module still contains unresolved bare package imports',
			),
		}),
	).toBeNull()

	const platformEvent = {
		type: undefined,
		message: 'unresolved bare package imports',
		exception: {
			values: [{ type: 'Error', value: 'declared but unresolved' }],
		},
	}
	expect(
		filterUserCodeErrorSentryEvent(platformEvent, {
			originalException: new Error(
				'Saved package module still contains unresolved bare package imports after bundling (bundle.js: "remix/data-schema")',
			),
		}),
	).toBe(platformEvent)
})
