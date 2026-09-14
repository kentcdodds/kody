import { RequestContext } from 'remix/router'
import { expect, test } from 'vitest'
import {
	createTemporaryModuleGraph,
	type RuntimeModule,
} from '#worker/test-support/module-graph.ts'
import {
	createAppEntrypointSource,
	createPackageRuntimeModuleSource,
	createRuntimeModuleSource,
} from './runtime-source-modules.ts'

test('the app bootstrap dispatches every export shape on the mount-stripped path', async () => {
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
		// Router-shaped objects are not special: they see the same stripped
		// path as every other fetch handler. A Remix recipe remounts itself.
		expect(await routerResponse.text()).toBe('router:/notes')
		expect(routerBootstrap.calls_).toEqual([3])

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
		).rejects.toThrow(/default export a fetch handler/)
	} finally {
		await moduleGraph.cleanup()
	}
})

test('KodyRuntime is a request-context key whose default value is the current run runtime, stamped per package', async () => {
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
			// Remix RequestContext: nothing calls set(), so get() falls back
			// to the key's defaultValue. Other libraries can ignore this key.
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
