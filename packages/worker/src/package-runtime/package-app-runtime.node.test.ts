import { readFile } from 'node:fs/promises'
import { RequestContext } from 'remix/router'
import { expect, test } from 'vitest'
import {
	createTemporaryModuleGraph,
	type RuntimeModule,
} from '#worker/test-support/module-graph.ts'
import {
	createKeepNamesPlugin,
	createPackageAppRemixClientBundleOptions,
	createPackageAppRemixServerBundleOptions,
	entryGraphNeedsRemixUiBundleOptions,
	packageAppServerModuleUrl,
} from './package-app-runtime.ts'
import {
	createAppEntrypointSource,
	createPackageRuntimeModuleSource,
	createRuntimeModuleSource,
	packageAppRuntimeMarkerExportName,
} from './runtime-source-modules.ts'

const remixUiEntryGraph = {
	'app/router.ts': [
		"import { createRouter } from 'remix/router'",
		"import { render } from './render.tsx'",
		'export default createRouter()',
	].join('\n'),
	'app/render.tsx':
		"import { renderToString } from 'remix/ui/server'\nexport const render = renderToString",
}

const fetchEntryGraph = {
	'src/app.ts': [
		"import { helper } from './helper.ts'",
		'export default { fetch: () => new Response(helper()) }',
	].join('\n'),
	'src/helper.ts': "export const helper = () => 'ok'",
	// Reachable only through a type import target, never in the graph.
	'src/types.d.ts': "import type { Router } from 'remix/router'",
	// Not reachable from the entry at all.
	'src/unused.ts': "import { html } from 'remix/ui/server'",
}

test('entryGraphNeedsRemixUiBundleOptions is true only when remix/ui is reachable from the entry', () => {
	expect(
		entryGraphNeedsRemixUiBundleOptions({
			sourceFiles: remixUiEntryGraph,
			entryPoint: 'app/router.ts',
		}),
	).toBe(true)
	expect(
		entryGraphNeedsRemixUiBundleOptions({
			sourceFiles: fetchEntryGraph,
			entryPoint: 'src/app.ts',
		}),
	).toBe(false)
	const borrowsHtmlTemplate = {
		'src/app.ts': [
			"import { html } from 'remix/html-template'",
			'export default { fetch: () => new Response(String(html`<p>hi</p>`)) }',
		].join('\n'),
	}
	expect(
		entryGraphNeedsRemixUiBundleOptions({
			sourceFiles: borrowsHtmlTemplate,
			entryPoint: 'src/app.ts',
		}),
	).toBe(false)
	const routerOnly = {
		'app/router.ts': [
			"import { createRouter } from 'remix/router'",
			'export default createRouter()',
		].join('\n'),
	}
	expect(
		entryGraphNeedsRemixUiBundleOptions({
			sourceFiles: routerOnly,
			entryPoint: 'app/router.ts',
		}),
	).toBe(false)
	const borrowsHeaders = {
		'src/app.ts': [
			"import { CacheControl } from 'remix/headers'",
			'export default { fetch: () => new Response("ok") }',
		].join('\n'),
	}
	expect(
		entryGraphNeedsRemixUiBundleOptions({
			sourceFiles: borrowsHeaders,
			entryPoint: 'src/app.ts',
		}),
	).toBe(false)
})

test('Remix bundle options compile JSX against remix/ui, pin import.meta.url on the server, and keep component names', () => {
	const server = createPackageAppRemixServerBundleOptions()
	expect(server).toMatchObject({
		jsx: 'automatic',
		jsxImportSource: 'remix/ui',
		define: { 'import.meta.url': JSON.stringify(packageAppServerModuleUrl) },
	})
	const plugins = server.__dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired
	expect(plugins).toHaveLength(1)
	const initialOptions: { keepNames?: boolean } = {}
	createKeepNamesPlugin().setup({ initialOptions })
	expect(initialOptions.keepNames).toBe(true)

	const client = createPackageAppRemixClientBundleOptions()
	expect(client).toEqual({ jsx: 'automatic', jsxImportSource: 'remix/ui' })
})

test('the app bootstrap remounts a router-shaped export and leaves a fetch handler on the stripped path', async () => {
	const moduleGraph = await createTemporaryModuleGraph({
		'router-app.js': [
			'const calls = []',
			'export const calls_ = calls',
			'export default {',
			'\tmap() {},',
			'\tmount() {},',
			'\tasync fetch(...args) {',
			'\t\tcalls.push(args.length)',
			'\t\treturn new Response("router:" + new URL(args[0].url).pathname)',
			'\t},',
			'}',
		].join('\n'),
		'router-bootstrap.js': createAppEntrypointSource({
			modulePath: './router-app.js',
		}),
		'fetch-app.js': [
			'export default {',
			'\tasync fetch(request, env, ctx) {',
			'\t\treturn new Response(`fetch:${new URL(request.url).pathname}:${env.marker}:${typeof ctx}`)',
			'\t},',
			'}',
		].join('\n'),
		'fetch-bootstrap.js': createAppEntrypointSource({
			modulePath: './fetch-app.js',
		}),
		'function-app.js': 'export default (request) => new Response("fn")',
		'function-bootstrap.js': createAppEntrypointSource({
			modulePath: './function-app.js',
		}),
		'broken-app.js': 'export const nothing = true',
		'broken-bootstrap.js': createAppEntrypointSource({
			modulePath: './broken-app.js',
		}),
	})
	try {
		type Bootstrap = {
			default: {
				fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>
			}
			calls_?: Array<number>
		}
		const routerBootstrap = (await moduleGraph.importModule(
			'router-bootstrap.js',
		)) as Bootstrap
		const routerResponse = await routerBootstrap.default.fetch(
			new Request('https://kent.kody.run/notes'),
			{
				marker: 'env',
				__kodyPackageContext: { appBasePath: '/packages/app' },
			},
			{},
		)
		expect(await routerResponse.text()).toBe('router:/packages/app/notes')
		// Only the request reaches router.fetch: the Worker env would be read
		// as RequestInit.
		expect(routerBootstrap.calls_).toEqual([1])
		expect(routerBootstrap).not.toHaveProperty(
			packageAppRuntimeMarkerExportName,
		)

		const fetchBootstrap = (await moduleGraph.importModule(
			'fetch-bootstrap.js',
		)) as Bootstrap
		const fetchResponse = await fetchBootstrap.default.fetch(
			new Request('https://kent.kody.run/notes'),
			{ marker: 'env' },
			{},
		)
		expect(await fetchResponse.text()).toBe('fetch:/notes:env:object')

		const functionBootstrap = (await moduleGraph.importModule(
			'function-bootstrap.js',
		)) as Bootstrap
		const functionResponse = await functionBootstrap.default.fetch(
			new Request('https://kent.kody.run/notes'),
			{
				__kodyPackageContext: { appBasePath: '/packages/app' },
			},
			{},
		)
		expect(await functionResponse.text()).toBe('fn')

		await expect(
			moduleGraph.importModule('broken-bootstrap.js'),
		).rejects.toThrow(/default export a Remix router .* or a fetch handler/)
		expect(fetchBootstrap).not.toHaveProperty(packageAppRuntimeMarkerExportName)
	} finally {
		await moduleGraph.cleanup()
	}
})

/**
 * Historical bootstrap persisted before remount moved into the bootstrap:
 * forwarded the stripped path and exported the runtime marker so the wrapper
 * would remount Remix routers.
 */
function createLegacyRuntimeMarkerBootstrapSource(modulePath: string) {
	return `
import * as userModule from ${JSON.stringify(modulePath)};
export * from ${JSON.stringify(modulePath)};

function isRemixRouter(candidate) {
	return (
		candidate != null &&
		typeof candidate === 'object' &&
		typeof candidate.fetch === 'function' &&
		typeof candidate.map === 'function' &&
		typeof candidate.mount === 'function'
	);
}

function resolvePackageAppHandler() {
	const candidate = userModule.default ?? userModule;
	if (typeof candidate === 'function') return candidate;
	if (isRemixRouter(candidate)) return (request) => candidate.fetch(request);
	if (candidate && typeof candidate.fetch === 'function') {
		return candidate.fetch.bind(candidate);
	}
	throw new Error('missing handler');
}

const handler = resolvePackageAppHandler();
export const ${packageAppRuntimeMarkerExportName} = isRemixRouter(
	userModule.default ?? userModule,
)
	? 'remix'
	: 'fetch';

export default {
	async fetch(request, env, ctx) {
		return await handler(request, env, ctx);
	},
};
`.trim()
}

async function createPackageAppDispatchHelpersForTest() {
	const sourceText = await readFile(
		new URL('./package-app.ts', import.meta.url),
		'utf8',
	)
	const start = sourceText.indexOf(
		'function createMountedPackageAppRequest(request, packageContext) {',
	)
	const end = sourceText.indexOf('\nasync function startRuntimeRun', start)
	if (start < 0 || end < 0) {
		throw new Error('package-app dispatch helpers were not found.')
	}
	const functionSource = sourceText
		.slice(start, end)
		.replaceAll('\\\\', '\\')
		.replaceAll('\\`', '`')
		.replaceAll('\\${', '${')
		.replaceAll(
			'${JSON.stringify(packageAppRuntimeMarkerExportName)}',
			JSON.stringify(packageAppRuntimeMarkerExportName),
		)
	return new Function(
		`${functionSource}; return { createMountedPackageAppRequest, resolvePackageAppRuntimeKind };`,
	)() as {
		createMountedPackageAppRequest: (
			request: Request,
			packageContext: { appBasePath?: string } | null,
		) => Request
		resolvePackageAppRuntimeKind: (userModule: object) => 'remix' | 'fetch'
	}
}

test('the wrapper remounts persisted remix artifacts that still export the runtime marker', async () => {
	const { createMountedPackageAppRequest, resolvePackageAppRuntimeKind } =
		await createPackageAppDispatchHelpersForTest()
	const packageContext = { appBasePath: '/packages/app' }
	const moduleGraph = await createTemporaryModuleGraph({
		'router-app.js': [
			'export default {',
			'\tmap() {},',
			'\tmount() {},',
			'\tasync fetch(request) {',
			'\t\treturn new Response("router:" + new URL(request.url).pathname)',
			'\t},',
			'}',
		].join('\n'),
		'legacy-router-bootstrap.js':
			createLegacyRuntimeMarkerBootstrapSource('./router-app.js'),
		'current-router-bootstrap.js': createAppEntrypointSource({
			modulePath: './router-app.js',
		}),
		'fetch-app.js': [
			'export default {',
			'\tasync fetch(request) {',
			'\t\treturn new Response("fetch:" + new URL(request.url).pathname)',
			'\t},',
			'}',
		].join('\n'),
		'legacy-fetch-bootstrap.js':
			createLegacyRuntimeMarkerBootstrapSource('./fetch-app.js'),
		'current-fetch-bootstrap.js': createAppEntrypointSource({
			modulePath: './fetch-app.js',
		}),
	})
	try {
		type Bootstrap = {
			default: {
				fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>
			}
		}
		const wrap = async (userModule: Bootstrap, request: Request) => {
			const dispatchedRequest =
				resolvePackageAppRuntimeKind(userModule) === 'remix'
					? createMountedPackageAppRequest(request, packageContext)
					: request
			return await userModule.default.fetch(
				dispatchedRequest,
				{ __kodyPackageContext: packageContext },
				{},
			)
		}
		const stripped = new Request('https://kent.kody.run/notes')

		const legacyRouter = (await moduleGraph.importModule(
			'legacy-router-bootstrap.js',
		)) as Bootstrap
		expect(legacyRouter).toMatchObject({
			[packageAppRuntimeMarkerExportName]: 'remix',
		})
		expect(await (await wrap(legacyRouter, stripped)).text()).toBe(
			'router:/packages/app/notes',
		)

		const currentRouter = (await moduleGraph.importModule(
			'current-router-bootstrap.js',
		)) as Bootstrap
		expect(currentRouter).not.toHaveProperty(packageAppRuntimeMarkerExportName)
		expect(await (await wrap(currentRouter, stripped)).text()).toBe(
			'router:/packages/app/notes',
		)

		const legacyFetch = (await moduleGraph.importModule(
			'legacy-fetch-bootstrap.js',
		)) as Bootstrap
		expect(legacyFetch).toMatchObject({
			[packageAppRuntimeMarkerExportName]: 'fetch',
		})
		expect(await (await wrap(legacyFetch, stripped)).text()).toBe(
			'fetch:/notes',
		)

		const currentFetch = (await moduleGraph.importModule(
			'current-fetch-bootstrap.js',
		)) as Bootstrap
		expect(currentFetch).not.toHaveProperty(packageAppRuntimeMarkerExportName)
		expect(await (await wrap(currentFetch, stripped)).text()).toBe(
			'fetch:/notes',
		)
	} finally {
		await moduleGraph.cleanup()
	}
})

test('KodyRuntime is a Remix context key whose default value is the current run runtime, stamped per package', async () => {
	const moduleGraph = await createTemporaryModuleGraph({
		'.__kody_virtual__/runtime.js': createRuntimeModuleSource(),
		'.__kody_virtual__/package-runtime/stamped.js':
			createPackageRuntimeModuleSource('pkg-stamped'),
		'entry.js': [
			"import { KodyRuntime } from './.__kody_virtual__/runtime.js'",
			"import { KodyRuntime as StampedKodyRuntime } from './.__kody_virtual__/package-runtime/stamped.js'",
			'export { KodyRuntime, StampedKodyRuntime }',
		].join('\n'),
	})
	try {
		const runtimeModule = (await moduleGraph.importModule(
			'.__kody_virtual__/runtime.js',
			{ cacheBust: false },
		)) as RuntimeModule
		const entry = (await moduleGraph.importModule('entry.js', {
			cacheBust: false,
		})) as {
			KodyRuntime: { defaultValue: Record<string, unknown> }
			StampedKodyRuntime: { defaultValue: Record<string, unknown> }
		}
		expect(Object.isFrozen(entry.KodyRuntime)).toBe(true)
		expect(Object.hasOwn(entry.KodyRuntime, 'defaultValue')).toBe(true)

		const storageCalls: Array<string> = []
		const runtime = {
			packageContext: {
				packageId: 'pkg-app',
				kodyId: 'app',
				appBasePath: '/packages/app',
				hostedUrl: 'https://kent.kody.run/packages/app',
			},
			__kodyPackageStorage: (packageId: string) => {
				storageCalls.push(packageId)
				return { id: `package:${packageId}` }
			},
			realtime: { broadcast: async () => ({ delivered: 1 }) },
		}
		const result = await runtimeModule.__kodyRunInRuntime(runtime, async () => {
			// A real Remix request context: nothing calls set(), so get() falls
			// back to the key's defaultValue.
			const context = new RequestContext(
				new Request('https://kent.kody.run/packages/app/notes'),
			)
			const kody = context.get(entry.KodyRuntime) as {
				packageContext: { appBasePath: string }
				packageStorage: () => { id: string }
				realtime: { broadcast(): Promise<unknown> }
			}
			const stamped = context.get(entry.StampedKodyRuntime) as {
				packageStorage: () => { id: string }
			}
			return {
				appBasePath: kody.packageContext.appBasePath,
				storageId: kody.packageStorage().id,
				stampedStorageId: stamped.packageStorage().id,
				broadcast: await kody.realtime.broadcast(),
				has: context.has(entry.KodyRuntime),
			}
		})
		expect(result).toEqual({
			appBasePath: '/packages/app',
			// Unstamped: the run's own package; stamped: the declaring package.
			storageId: 'package:pkg-app',
			stampedStorageId: 'package:pkg-stamped',
			broadcast: { delivered: 1 },
			has: false,
		})
		expect(storageCalls).toEqual(['pkg-app', 'pkg-stamped'])
	} finally {
		await moduleGraph.cleanup()
	}
})
