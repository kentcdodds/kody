import { RequestContext } from 'remix/router'
import { expect, test } from 'vitest'
import {
	createTemporaryModuleGraph,
	type RuntimeModule,
} from '#worker/test-support/module-graph.ts'
import { entryGraphNeedsRemixUiBundleOptions } from './package-app-runtime.ts'
import {
	createAppEntrypointSource,
	createPackageRuntimeModuleSource,
	createRuntimeModuleSource,
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
