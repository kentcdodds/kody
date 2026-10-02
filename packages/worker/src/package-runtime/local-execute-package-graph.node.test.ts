import { expect, test, vi, beforeEach } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createSavedPackageRecord,
} from '#worker/test-support/module-graph.ts'
import {
	buildLocalExecutePackageGraph,
	createLocalExecutePackageRuntimeModuleSource,
	createLocalExecuteRuntimeShimSource,
	localExecuteHostRuntimeModuleName,
	pickLocalExecutePrimaryRuntimePath,
	type LocalExecutePackageGraphError,
} from './local-execute-package-graph.ts'
import {
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
	resolveRelativeModulePath,
	runtimeModulePath,
} from './module-graph-paths.ts'

vi.mock('#worker/package-registry/scope-grants.ts', () => ({
	getPlatformAccountByUsername: mockModule.getPlatformAccountByUsername,
	isPlatformAccountStableUserId: async () => false,
	listPlatformAccountUsernames: async () => [],
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactsModule>(
		'./published-bundle-artifacts.ts',
	)
	return {
		...actual,
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.loadPublishedBundleArtifactByIdentity(...args),
	}
})

beforeEach(() => {
	vi.clearAllMocks()
	mockModule.getPlatformAccountByUsername.mockResolvedValue(null)
})

const graphInput = {
	env: { APP_DB: {}, REPO_SESSION: {} } as Env,
	baseUrl: 'https://heykody.dev',
	userId: 'user-1',
}

const examplePackage = {
	name: '@kentcdodds/example-package',
	kodyId: 'example-package',
}

function manifestJson(input: {
	name: string
	kodyId: string
	exports: Record<string, string>
}) {
	return JSON.stringify({
		name: input.name,
		exports: input.exports,
		kody: { id: input.kodyId, description: 'Example package' },
	})
}

function makeLoadedSource(input: {
	exports: Record<string, string>
	files: Record<string, string>
	publishedCommit?: string | null
}) {
	return {
		source: {
			id: 'source-1',
			published_commit: input.publishedCommit ?? 'commit-1',
		},
		manifest: {
			name: examplePackage.name,
			exports: input.exports,
			kody: { id: examplePackage.kodyId, description: 'Example package' },
		},
		files: {
			'package.json': manifestJson({
				...examplePackage,
				exports: input.exports,
			}),
			...input.files,
		},
	}
}

function makeArtifactHit(input: {
	artifactName: string
	entryPoint: string
	mainModule: string
	modules: Record<string, string>
}) {
	return {
		row: { id: `artifact-${input.artifactName}` },
		artifact: {
			version: 1,
			kind: 'importable-module' as const,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
			mainModule: input.mainModule,
			modules: input.modules,
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: examplePackage.kodyId,
				sourceId: 'source-1',
			},
			createdAt: '2026-05-01T00:00:00.000Z',
		},
	}
}

test('buildLocalExecutePackageGraph returns embeddable kody:@ modules from published artifacts', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts':
					'export function greet(name) { return "hi " + name }\nexport default greet',
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: './hello',
			entryPoint: 'src/hello.ts',
			mainModule: 'dist/hello.js',
			modules: {
				'dist/hello.js':
					'export function greet(name) { return "hi " + name }\nexport default greet',
			},
		}),
	)

	const code = `import { greet } from 'kody:@kentcdodds/example-package/hello'
export default async function main(params) { return greet(params.name) }`
	const graph = await buildLocalExecutePackageGraph({ ...graphInput, code })

	expect(graph.imports).toEqual(['kody:@kentcdodds/example-package/hello'])
	expect(graph.warnings).toEqual([])
	const entry = graph.modules.find(
		(module) => module.name === 'kody:@kentcdodds/example-package/hello',
	)
	expect(entry).toBeDefined()
	expect(entry?.esModule).toMatch(/from ["']\.\.?\/.*\.__published_bundle__\//)
	expect(entry?.esModule).toContain('dist/hello.js')
	expect(entry?.esModule).not.toMatch(/from ["']\.__kody_packages__\//)
	expect(
		graph.modules.some(
			(module) =>
				module.name.includes('.__published_bundle__/') &&
				module.name.endsWith('/dist/hello.js'),
		),
	).toBe(true)
	expect(
		graph.modules.some(
			(module) => module.name === '.__kody_virtual__/runtime.js',
		),
	).toBe(true)
	const runtimeShim = graph.modules.find(
		(module) => module.name === '.__kody_virtual__/runtime.js',
	)?.esModule
	expect(runtimeShim).toContain(localExecuteHostRuntimeModuleName)
	// Bare "kody:runtime" path-joins under .__kody_virtual__/ in local workerd.
	expect(runtimeShim).toContain('"../kody:runtime"')
	expect(runtimeShim).not.toMatch(/from ["']kody:runtime["']/)
	expect(runtimeShim).toContain('createAuthenticatedFetch')
	expect(runtimeShim).toContain('kody.authenticatedFetch')
	expect(runtimeShim).toContain('bodyBase64')
	expect(runtimeShim).toContain('__kodyNullBodyStatuses')
	expect(runtimeShim).toContain('__kodyCreatePackageBoundAuthenticatedFetch')
	expect(runtimeShim).toContain('__kodyCreatePackageBoundStorage')
	expect(runtimeShim).toContain('kody.packageStorageGet')
	expect(runtimeShim).toContain('__kodyCreatePackageBoundSecrets')
	expect(runtimeShim).toContain('__kodySecretAuthorityPackageId')
	expect(runtimeShim).toContain('secretHeaders')
	expect(runtimeShim).toContain('oauthClientCredentials')
	expect(runtimeShim).toContain('kody.oauthClientCredentials')
	expect(runtimeShim).toContain('{{secret-basic:')
	// Shim owns secretHeaders / oauthClientCredentials — do not re-export the
	// CLI host's intentional `undefined` placeholders.
	expect(runtimeShim).not.toMatch(
		/import \{[\s\S]*secretHeaders[\s\S]*\} from ["']\.\.\/kody:runtime["']/,
	)
	const packageRuntimeModules = graph.modules.filter((module) =>
		module.name.includes('/.__kody_virtual__/package-runtime/'),
	)
	for (const module of packageRuntimeModules) {
		expect(module.esModule).toContain(
			'__kodyCreatePackageBoundAuthenticatedFetch',
		)
	}
	expect(
		graph.modules.some((module) => module.name.startsWith('.__kody_root__/')),
	).toBe(false)
})

test('buildLocalExecutePackageGraph rewrites inlined virtual runtime onto the CapabilityProxy shim', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './smoke-test': './src/smoke-test.ts' },
			files: {
				'src/smoke-test.ts': `import { createAuthenticatedFetch } from 'kody:runtime'
export default async function smokeTest() { return typeof createAuthenticatedFetch }`,
			},
		}),
	)
	const packageId = '2cc996d8-c0f5-4339-a6c1-9b6206123e96'
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: './smoke-test',
			entryPoint: 'src/smoke-test.ts',
			mainModule: 'dist/smoke-test.js',
			modules: {
				'dist/smoke-test.js': `// virtual:.__kody_virtual__/runtime.js
import { AsyncLocalStorage } from "node:async_hooks";
var __kodyRuntimeStorage = new AsyncLocalStorage();
var __kodyInitialRuntime = __kodyRuntimeStorage.getStore();
function __kodyOptionalRuntimeFunctionExport(exportName) {
  if (__kodyInitialRuntime === void 0) return void 0;
  return () => {};
}
function __kodyCreatePackageBoundStorage(id) { return () => ({ id }); }
function __kodyCreatePackageBoundSecrets(id) { return { get: async () => "", has: async () => false }; }
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
var runtime_default = { createAuthenticatedFetch };
// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});
// virtual:.__kody_root__/src/smoke-test.ts
export default async function smokeTest() {
  return typeof createAuthenticatedFetch;
}
`,
				'.__kody_virtual__/runtime.js':
					'export function createAuthenticatedFetch() { throw new Error("stale") }',
			},
		}),
	)

	const graph = await buildLocalExecutePackageGraph({
		...graphInput,
		code: `import smokeTest from 'kody:@kentcdodds/example-package/smoke-test'
export default async function main() { return await smokeTest() }`,
	})

	const bundle = graph.modules.find((module) =>
		module.name.endsWith('/dist/smoke-test.js'),
	)
	expect(bundle).toBeDefined()
	expect(bundle?.esModule).toContain(
		'__kodyCreatePackageBoundAuthenticatedFetch',
	)
	expect(bundle?.esModule).toContain(JSON.stringify(packageId))
	expect(bundle?.esModule).not.toContain(
		'__kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch")',
	)
	expect(bundle?.esModule).toContain(
		'// virtual:.__kody_root__/src/smoke-test.ts',
	)
})

test('createLocalExecuteRuntimeShimSource exposes a fixed local host-binding inventory', () => {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	const requiredCallableExports = [
		'createAuthenticatedFetch',
		'oauthClientCredentials',
		'__kodyCreatePackageBoundAuthenticatedFetch',
		'__kodyCreatePackageBoundStorage',
		'__kodyCreatePackageBoundSecrets',
		'packageStorage',
	] as const
	for (const name of requiredCallableExports) {
		expect(shim).toMatch(
			new RegExp(`(export (async )?function|export const) ${name}\\b`),
		)
	}
	expect(shim).toMatch(/export const secretHeaders = \{/)
	expect(shim).toMatch(/export const packageSecrets = \{/)
	expect(shim).toContain('kody.authenticatedFetch')
	expect(shim).toContain('kody.oauthClientCredentials')
	expect(shim).toContain('kody.packageStorageGet')
	expect(shim).toContain('kody.packageSecretGet')
})

test('createLocalExecuteRuntimeShimSource uses a relative host import from path-like module names', () => {
	const canonical = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	expect(canonical).toContain('"../kody:runtime"')
	expect(canonical).not.toMatch(/from ["']kody:runtime["']/)

	const nestedPath =
		'.__kody_packages__/@kentcdodds/google/.__published_bundle__/2e2f676d61696c/.__kody_virtual__/runtime.js'
	const nested = createLocalExecuteRuntimeShimSource(nestedPath)
	const relativeHost = createRelativeImportSpecifier(
		nestedPath,
		localExecuteHostRuntimeModuleName,
	)
	expect(relativeHost.startsWith('../')).toBe(true)
	expect(nested).toContain(JSON.stringify(relativeHost))
	expect(nested).not.toMatch(/from ["']kody:runtime["']/)
	expect(resolveRelativeModulePath(nestedPath, relativeHost)).toBe(
		localExecuteHostRuntimeModuleName,
	)
})

test('pickLocalExecutePrimaryRuntimePath prefers the canonical runtime root', () => {
	const nested =
		'.__kody_packages__/@kentcdodds/google/.__published_bundle__/2e/.__kody_virtual__/runtime.js'
	expect(pickLocalExecutePrimaryRuntimePath([nested, runtimeModulePath])).toBe(
		runtimeModulePath,
	)
	expect(pickLocalExecutePrimaryRuntimePath([nested])).toBe(
		normalizeWorkspaceModulePath(nested),
	)
	expect(pickLocalExecutePrimaryRuntimePath([])).toBe(runtimeModulePath)
})

test('buildLocalExecutePackageGraph re-exports nested published-bundle runtime.js to the primary shim', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './gmail': './src/gmail.ts' },
			files: {
				'src/gmail.ts': `import { createAuthenticatedFetch } from 'kody:runtime'\nexport async function searchMessages() { return typeof createAuthenticatedFetch }`,
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: './gmail',
			entryPoint: 'src/gmail.ts',
			mainModule: 'dist/gmail.js',
			modules: {
				'dist/gmail.js': `import { createAuthenticatedFetch } from './.__kody_virtual__/runtime.js'\nexport async function searchMessages() { return typeof createAuthenticatedFetch }`,
				'.__kody_virtual__/runtime.js':
					'export function createAuthenticatedFetch() { throw new Error("stale") }',
			},
		}),
	)

	const code = `import { searchMessages } from 'kody:@kentcdodds/example-package/gmail'
export default async function main() {
	return { ok: true, kind: typeof searchMessages }
}`
	const graph = await buildLocalExecutePackageGraph({ ...graphInput, code })

	const primary = graph.modules.find(
		(module) => module.name === runtimeModulePath,
	)
	expect(primary?.esModule).toContain('"../kody:runtime"')
	expect(primary?.esModule).not.toMatch(/from ["']kody:runtime["']/)

	const nested = graph.modules.find(
		(module) =>
			module.name.includes('/.__published_bundle__/') &&
			module.name.endsWith('/.__kody_virtual__/runtime.js'),
	)
	expect(nested).toBeDefined()
	expect(nested?.name).toContain('/2e2f676d61696c/')
	expect(nested?.esModule).toMatch(/export \* from ["']\.\.\/\.\.\//)
	expect(nested?.esModule).not.toMatch(/from ["']kody:runtime["']/)
	expect(nested?.esModule).not.toContain('__kodyCreateAuthenticatedFetch')
	const reexportMatch =
		/export \* from ("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(
			nested?.esModule ?? '',
		)
	expect(reexportMatch?.[1]).toBeDefined()
	const reexportSpecifier = JSON.parse(
		reexportMatch![1]!.startsWith("'")
			? `"${reexportMatch![1]!.slice(1, -1).replaceAll('"', '\\"')}"`
			: reexportMatch![1]!,
	) as string
	expect(resolveRelativeModulePath(nested!.name, reexportSpecifier)).toBe(
		runtimeModulePath,
	)
})

test('buildLocalExecutePackageGraph rejects literal dynamic kody:@ imports', async () => {
	const code = `const m = await import('kody:@kentcdodds/example-package/hello')
export default async () => m`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'unsupported_dynamic_package_import',
	} satisfies Partial<LocalExecutePackageGraphError>)
	expect(mockModule.getSavedPackageByName).not.toHaveBeenCalled()
})

test('buildLocalExecutePackageGraph rejects unresolved packages', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(null)
	mockModule.getPlatformAccountByUsername.mockResolvedValue(null)
	const code = `import x from 'kody:@missing/pkg/export'
export default async () => x`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unresolved',
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph rejects unpublished packages without artifacts', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts': 'export default function hello() { return "hi" }',
			},
			publishedCommit: null,
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

	const code = `import hello from 'kody:@kentcdodds/example-package/hello'
export default async () => hello()`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unpublished',
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph rejects missing published artifacts', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts': 'export default function hello() { return "hi" }',
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

	const code = `import hello from 'kody:@kentcdodds/example-package/hello'
export default async () => hello()`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unpublished',
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph returns an empty graph when there are no kody:@ imports', async () => {
	const graph = await buildLocalExecutePackageGraph({
		...graphInput,
		code: 'export default async function main() { return 1 }',
	})
	expect(graph).toEqual({ modules: [], imports: [], warnings: [] })
	expect(mockModule.getSavedPackageByName).not.toHaveBeenCalled()
})

test('createLocalExecutePackageRuntimeModuleSource clones frozen base before proxy overrides', () => {
	const packageId = 'pkg-proxy-invariant'
	const source = createLocalExecutePackageRuntimeModuleSource(packageId)
	expect(source).toContain('Object.freeze({')
	expect(source).toContain('...__kodyBaseRuntimeDefault')
	expect(source).toContain(
		`__kodyCreatePackageBoundAuthenticatedFetch(${JSON.stringify(packageId)})`,
	)

	// Regression: Proxy over a frozen base that returns different bound
	// values throws on get. The generated module freezes a clone with the
	// overrides so default-export access stays valid.
	const unboundStorage = () => ({ id: 'unbound' })
	const boundStorage = () => ({ id: `package:${packageId}` })
	const base = Object.freeze({
		kody: {},
		packageStorage: unboundStorage,
		packageSecrets: { get: async () => null },
		createAuthenticatedFetch: async () => {
			throw new Error('unbound')
		},
	})
	const broken = new Proxy(base, {
		get(target, property, receiver) {
			if (property === 'packageStorage') return boundStorage
			return Reflect.get(target, property, receiver)
		},
	})
	expect(() => broken.packageStorage).toThrow(/proxy/i)

	const fixed = new Proxy(
		Object.freeze({
			...base,
			packageStorage: boundStorage,
		}),
		{
			get(target, property, receiver) {
				if (property === 'packageStorage') return boundStorage
				return Reflect.get(target, property, receiver)
			},
		},
	)
	expect(fixed.packageStorage().id).toBe(`package:${packageId}`)
})
