import { expect, test, vi, beforeEach } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createSavedPackageRecord,
} from '#worker/test-support/module-graph.ts'
import {
	buildLocalExecutePackageGraph,
	localExecuteHostRuntimeModuleName,
	pickLocalExecutePrimaryRuntimePath,
	type LocalExecutePackageGraphError,
} from './local-execute-package-graph.ts'
import { createLocalExecuteRuntimeShimSource } from './local-execute-runtime-support.ts'
import {
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

test('buildLocalExecutePackageGraph rewrites user-secret placeholders onto gateway fetch', async () => {
	const packageId = 'pkg-1'
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { '.': './src/index.ts' },
			files: {
				'src/index.ts': `const SECRET_API_TOKEN = '{{secret:demoAnalyticsToken|scope=user}}'
export async function listSites() {
  return fetch('https://api.usefathom.com/v1/sites', {
    headers: { authorization: 'Bearer ' + SECRET_API_TOKEN },
  })
}
export default listSites`,
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: '.',
			entryPoint: 'src/index.ts',
			mainModule: 'dist/index.js',
			modules: {
				'dist/index.js': `const SECRET_API_TOKEN = '{{secret:demoAnalyticsToken|scope=user}}';
export async function listSites() {
  return fetch("https://api.usefathom.com/v1/sites", {
    headers: { authorization: "Bearer " + SECRET_API_TOKEN }
  });
}
export default listSites;
`,
			},
		}),
	)

	const graph = await buildLocalExecutePackageGraph({
		...graphInput,
		code: `import { listSites } from 'kody:@kentcdodds/example-package'
export default async function main() { return await listSites() }`,
	})

	const bundle = graph.modules.find((module) =>
		module.name.endsWith('/dist/index.js'),
	)
	expect(bundle).toBeDefined()
	expect(bundle?.esModule).not.toContain(
		'{{secret:demoAnalyticsToken|scope=user}}',
	)
	expect(bundle?.esModule).toContain(
		'__kodySecretRef("demoAnalyticsToken", "user")',
	)
	expect(bundle?.esModule).toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(bundle?.esModule).toContain(JSON.stringify(packageId))
	const runtimeShim = graph.modules.find(
		(module) => module.name === '.__kody_virtual__/runtime.js',
	)?.esModule
	expect(runtimeShim).toContain('__kodyGatewayFetch')
	expect(runtimeShim).toContain('kody.gatewayFetch')
})

test('local secretHeaders.basic parses opaque {{secret:…}} refs like cloud', () => {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	const start = shim.indexOf('const __kodyParseSecretNameOrPlaceholder')
	const end = shim.indexOf('// Client-credentials grants need host-side')
	expect(start).toBeGreaterThan(-1)
	expect(end).toBeGreaterThan(start)
	const helpersSource = shim
		.slice(start, end)
		.replace('export const secretHeaders', 'const secretHeaders')
	const secretHeaders = new Function(
		`${helpersSource}; return secretHeaders;`,
	)()
	expect(
		secretHeaders.basic({
			usernameSecret: '{{secret:paypalClientId|scope=user}}',
			passwordSecret: '{{secret:paypalClientSecret|scope=user}}',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
	expect(
		secretHeaders.basic({
			usernameSecret: 'paypalClientId',
			passwordSecret: 'paypalClientSecret',
			scope: 'user',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
})

test('local gateway fetch hops scoped secrets and preserves ambient body metadata', async () => {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	const start = shim.indexOf('const __kodyNullBodyStatuses')
	const end = shim.indexOf('export function __kodyCreatePackageBoundStorage')
	expect(start).toBeGreaterThan(-1)
	expect(end).toBeGreaterThan(start)
	const helpersSource = shim.slice(start, end).replaceAll(/^export /gm, '')
	const ambientCalls: Array<{ input: unknown; init: unknown }> = []
	const gatewayCalls: Array<unknown> = []
	const kody = {
		gatewayFetch: async (args: unknown) => {
			gatewayCalls.push(args)
			return {
				status: 200,
				statusText: 'OK',
				headers: {},
				bodyBase64: btoa('gw'),
			}
		},
	}
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: unknown, init?: unknown) => {
		ambientCalls.push({ input, init })
		return new Response('ambient')
	}) as typeof fetch
	try {
		const { __kodyGatewayFetch } = new Function(
			'kody',
			`${helpersSource}; return { __kodyGatewayFetch };`,
		)(kody) as {
			__kodyGatewayFetch: (
				input: RequestInfo | URL,
				init?: RequestInit,
			) => Promise<Response>
		}

		await __kodyGatewayFetch('https://api.example.com/v1', {
			headers: {
				authorization: 'Bearer {{secret:demoToken|scope=user}}',
			},
		})
		expect(gatewayCalls).toHaveLength(1)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls[0]).toMatchObject({
			request: {
				url: 'https://api.example.com/v1',
				headers: {
					authorization: 'Bearer {{secret:demoToken|scope=user}}',
				},
			},
		})

		ambientCalls.length = 0
		gatewayCalls.length = 0
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: 'plain-text-body',
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(1)
		// Reuse original init so ambient fetch keeps implicit Content-Type.
		expect(ambientCalls[0]?.input).toBe('https://api.example.com/post')
		expect((ambientCalls[0]?.init as RequestInit).body).toBe('plain-text-body')

		ambientCalls.length = 0
		gatewayCalls.length = 0
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('hello'))
				controller.close()
			},
		})
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: stream,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(1)
		expect(ambientCalls[0]?.input).toBe('https://api.example.com/post')
		expect(
			new TextDecoder().decode(
				(ambientCalls[0]?.init as RequestInit).body as Uint8Array,
			),
		).toBe('hello')

		ambientCalls.length = 0
		const typedBlob = new Blob(['blob-body'], { type: 'application/json' })
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: typedBlob,
		})
		expect(ambientCalls).toHaveLength(1)
		expect(
			new TextDecoder().decode(
				(ambientCalls[0]?.init as RequestInit).body as Uint8Array,
			),
		).toBe('blob-body')
		expect(
			(ambientCalls[0]?.init as RequestInit).headers as Record<string, string>,
		).toMatchObject({ 'content-type': 'application/json' })

		ambientCalls.length = 0
		const request = new Request('https://api.example.com/post', {
			method: 'POST',
			body: 'payload',
		})
		await __kodyGatewayFetch(request)
		expect(ambientCalls).toHaveLength(1)
		expect(typeof ambientCalls[0]?.input).toBe('string')
		expect(
			new TextDecoder().decode(
				(ambientCalls[0]?.init as RequestInit).body as Uint8Array,
			),
		).toBe('payload')
		expect(
			(ambientCalls[0]?.init as RequestInit).headers as Record<string, string>,
		).toMatchObject({
			'content-type': 'text/plain;charset=UTF-8',
		})

		ambientCalls.length = 0
		gatewayCalls.length = 0
		const form = new FormData()
		form.set('note', 'hello')
		await __kodyGatewayFetch('https://api.example.com/upload', {
			method: 'POST',
			body: form,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(1)
		expect(ambientCalls[0]?.input).toBe('https://api.example.com/upload')
		expect((ambientCalls[0]?.init as RequestInit).body).toBe(form)

		await expect(
			__kodyGatewayFetch('https://api.example.com/upload', {
				method: 'POST',
				headers: {
					authorization: 'Bearer {{secret:demoToken|scope=user}}',
				},
				body: form,
			}),
		).resolves.toBeInstanceOf(Response)
		expect(gatewayCalls).toHaveLength(1)
		expect(ambientCalls).toHaveLength(1) // only the earlier non-secret form
		expect(gatewayCalls[0]).toMatchObject({
			request: {
				url: 'https://api.example.com/upload',
				headers: {
					authorization: 'Bearer {{secret:demoToken|scope=user}}',
				},
			},
		})
		expect(
			(gatewayCalls[0] as { request: { bodyBase64?: string } }).request
				.bodyBase64,
		).toEqual(expect.any(String))

		const namedForm = new FormData()
		namedForm.set('{{secret:demoToken|scope=user}}', 'field-value')
		await expect(
			__kodyGatewayFetch('https://api.example.com/upload', {
				method: 'POST',
				body: namedForm,
			}),
		).rejects.toThrow(/FormData bodies with secret placeholders/)

		const requestForm = new FormData()
		requestForm.set('note', '{{secret:demoToken|scope=user}}')
		await expect(
			__kodyGatewayFetch(
				new Request('https://api.example.com/upload', {
					method: 'POST',
					body: requestForm,
				}),
			),
		).rejects.toThrow(/FormData bodies with secret placeholders/)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('createLocalExecuteRuntimeShimSource uses a relative host import from path-like module names', () => {
	const nestedPath =
		'.__kody_packages__/@kentcdodds/google/.__published_bundle__/2e2f676d61696c/.__kody_virtual__/runtime.js'
	const nested = createLocalExecuteRuntimeShimSource(nestedPath)
	expect(nested).not.toMatch(/from ["']kody:runtime["']/)
	const importMatch = /from ("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(nested)
	expect(importMatch?.[1]).toBeDefined()
	const specifier = JSON.parse(
		importMatch![1]!.startsWith("'")
			? `"${importMatch![1]!.slice(1, -1).replaceAll('"', '\\"')}"`
			: importMatch![1]!,
	) as string
	expect(specifier.startsWith('../')).toBe(true)
	expect(resolveRelativeModulePath(nestedPath, specifier)).toBe(
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

test('buildLocalExecutePackageGraph rejects unpublished packages and missing artifacts', async () => {
	const code = `import hello from 'kody:@kentcdodds/example-package/hello'
export default async () => hello()`
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts': 'export default function hello() { return "hi" }',
			},
			publishedCommit: null,
		}),
	)
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unpublished',
	} satisfies Partial<LocalExecutePackageGraphError>)

	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts': 'export default function hello() { return "hi" }',
			},
		}),
	)
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
