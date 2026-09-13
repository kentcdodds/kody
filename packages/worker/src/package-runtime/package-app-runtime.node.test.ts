import { RequestContext } from 'remix/router'
import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	createTemporaryModuleGraph,
	type RuntimeModule,
} from '#worker/test-support/module-graph.ts'
import {
	createKeepNamesPlugin,
	createPackageAppRemixClientBundleOptions,
	createPackageAppRemixServerBundleOptions,
	entryGraphImportsRemix,
	packageAppServerModuleUrl,
	resolvePackageAppRuntime,
} from './package-app-runtime.ts'
import {
	createAppEntrypointSource,
	createPackageRuntimeModuleSource,
	createRuntimeModuleSource,
	packageAppRuntimeMarkerExportName,
} from './runtime-source-modules.ts'

function createManifest(app: Record<string, unknown>) {
	return parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/runtime-app',
			exports: { '.': './src/index.ts' },
			kody: { id: 'runtime-app', description: 'runtime app', app },
		}),
		manifestPath: 'package.json',
	})
}

const remixEntryGraph = {
	'app/router.ts': [
		"import { createRouter } from 'remix/router'",
		"import { routes } from './routes.ts'",
		'export default createRouter()',
	].join('\n'),
	'app/routes.ts':
		"import { route } from 'remix/routes'\nexport const routes = route({ home: '/' })",
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
	'src/unused.ts': "import { html } from 'remix/html-template'",
}

test('resolvePackageAppRuntime prefers the declared runtime and otherwise infers it from remix imports reachable from the entry', () => {
	expect(
		resolvePackageAppRuntime({
			manifest: createManifest({ entry: './app/router.ts' }),
			sourceFiles: remixEntryGraph,
			entryPoint: 'app/router.ts',
		}),
	).toBe('remix')
	expect(
		resolvePackageAppRuntime({
			manifest: createManifest({ entry: './src/app.ts' }),
			sourceFiles: fetchEntryGraph,
			entryPoint: 'src/app.ts',
		}),
	).toBe('fetch')
	// A fetch app that only borrows html-template is still a Remix-runtime
	// bundle by inference; the declaration is the escape hatch.
	const borrowsHtmlTemplate = {
		'src/app.ts': [
			"import { html } from 'remix/html-template'",
			'export default { fetch: () => new Response(String(html`<p>hi</p>`)) }',
		].join('\n'),
	}
	expect(
		resolvePackageAppRuntime({
			manifest: createManifest({ entry: './src/app.ts' }),
			sourceFiles: borrowsHtmlTemplate,
			entryPoint: 'src/app.ts',
		}),
	).toBe('remix')
	expect(
		resolvePackageAppRuntime({
			manifest: createManifest({ runtime: 'fetch', entry: './src/app.ts' }),
			sourceFiles: borrowsHtmlTemplate,
			entryPoint: 'src/app.ts',
		}),
	).toBe('fetch')
	expect(
		resolvePackageAppRuntime({
			manifest: createManifest({ runtime: 'remix', entry: './src/app.ts' }),
			sourceFiles: fetchEntryGraph,
			entryPoint: 'src/app.ts',
		}),
	).toBe('remix')
	expect(
		resolvePackageAppRuntime({
			manifest: null,
			sourceFiles: remixEntryGraph,
			entryPoint: 'app/router.ts',
		}),
	).toBe('remix')
	expect(
		entryGraphImportsRemix({
			sourceFiles: fetchEntryGraph,
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

test('the app bootstrap dispatches a Remix router with the request alone and marks the runtime kind', async () => {
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
			__kodyPackageAppRuntime: string
			calls_?: Array<number>
		}
		const routerBootstrap = (await moduleGraph.importModule(
			'router-bootstrap.js',
		)) as Bootstrap
		expect(routerBootstrap[packageAppRuntimeMarkerExportName]).toBe('remix')
		const routerResponse = await routerBootstrap.default.fetch(
			new Request('https://kent.kody.run/packages/app/notes'),
			{ marker: 'env' },
			{},
		)
		expect(await routerResponse.text()).toBe('router:/packages/app/notes')
		// Only the request reaches router.fetch: the Worker env would be read
		// as RequestInit.
		expect(routerBootstrap.calls_).toEqual([1])

		const fetchBootstrap = (await moduleGraph.importModule(
			'fetch-bootstrap.js',
		)) as Bootstrap
		expect(fetchBootstrap[packageAppRuntimeMarkerExportName]).toBe('fetch')
		const fetchResponse = await fetchBootstrap.default.fetch(
			new Request('https://kent.kody.run/notes'),
			{ marker: 'env' },
			{},
		)
		expect(await fetchResponse.text()).toBe('fetch:/notes:env:object')

		const functionBootstrap = (await moduleGraph.importModule(
			'function-bootstrap.js',
		)) as Bootstrap
		expect(functionBootstrap[packageAppRuntimeMarkerExportName]).toBe('fetch')

		await expect(
			moduleGraph.importModule('broken-bootstrap.js'),
		).rejects.toThrow(/default export a Remix router .* or a fetch handler/)
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
