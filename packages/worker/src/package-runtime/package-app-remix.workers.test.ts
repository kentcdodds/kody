import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createRemixPackageAppFiles } from '#worker/test-support/remix-package-app-fixture.ts'
import { buildKodyAppBundle, buildKodyAppClientBundle } from './module-graph.ts'
import { packageAppClientModuleNamePattern } from './package-app-client-module-name.ts'

const appBasePath = '/packages/remix-notes'
const hostedOrigin = 'https://kent.kody.run'
const clientModuleUrl = `${hostedOrigin}${appBasePath}/_assets/client.0123456789abcdef.js`

/**
 * Stands in for the package-app wrapper: runs the bundled app inside the
 * same AsyncLocalStorage store `kody:runtime` reads, with an in-memory
 * `packageStorage()` and the `packageContext` fields a hosted request gets.
 * The host forwards the mount-stripped path; Remix recipes remount themselves.
 */
function createTestWrapperSource(mainModule: string) {
	return `
import { AsyncLocalStorage } from 'node:async_hooks';

const storageSymbol = Symbol.for('kody.runtimeStorage');
const als = globalThis[storageSymbol] ?? (globalThis[storageSymbol] = new AsyncLocalStorage());
const memory = new Map();
const packageContext = {
	packageId: 'pkg-remix-notes',
	kodyId: 'remix-notes',
	appBasePath: ${JSON.stringify(appBasePath)},
	hostedUrl: ${JSON.stringify(`${hostedOrigin}${appBasePath}`)},
	assetBasePath: ${JSON.stringify(`${appBasePath}/_assets`)},
	clientModuleUrl: ${JSON.stringify(clientModuleUrl)},
};
const runtime = {
	packageContext,
	__kodyPackageStorage: (packageId) => ({
		id: 'package:' + packageId,
		get: async (key) => memory.get(key) ?? null,
		set: async (key, value) => { memory.set(key, value); return { ok: true }; },
		delete: async (key) => { memory.delete(key); return { ok: true }; },
		list: async () => ({ entries: [...memory].map(([key, value]) => ({ key, value })) }),
		sql: async () => { throw new Error('sql is not part of this test'); },
		clear: async () => { memory.clear(); return { ok: true }; },
	}),
};

export default {
	async fetch(request, env, ctx) {
		return await als.run(runtime, async () => {
			// Like the real wrapper: the app module is first evaluated inside the
			// request store, so module-scope reads of packageContext (the route
			// prefix) see the mount. The host forwards the stripped path.
			const app = await import(${JSON.stringify(`./${mainModule}`)});
			const envWithContext = Object.assign(Object.create(env ?? {}), {
				__kodyPackageContext: packageContext,
			});
			return await app.default.fetch(request, envWithContext, ctx);
		});
	},
};
`.trim()
}

test(
	'a Remix package app bundles through esbuild-wasm and serves SSR routes, actions, and middleware in a dynamic worker',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const sourceFiles = createRemixPackageAppFiles({
			username: 'kent',
			kodyId: 'remix-notes',
		})
		const bundle = await buildKodyAppBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId: 'user-remix-workers-test',
			sourceFiles,
			entryPoint: 'app/router.ts',
		})
		const mainSource = bundle.modules[bundle.mainModule]
		expect(typeof mainSource).toBe('string')
		const code = mainSource as string
		// The platform's vendored Remix is inlined: nothing bare is left for
		// the isolate to resolve. The recipe writes an explicit island id.
		expect(code).not.toMatch(/from\s+["']remix\//)
		expect(code).toContain('kody:app#Counter')
		expect(code).not.toContain('import.meta.url')
		// JSX compiled against remix/ui from the recipe's tsconfig.
		expect(code).not.toContain('React.createElement')

		const wrapperModule = 'test-entry.js'
		const worker = env.APP_LOADER.load({
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: wrapperModule,
			modules: {
				...bundle.modules,
				[wrapperModule]: createTestWrapperSource(bundle.mainModule),
			},
		})
		const entrypoint = worker.getEntrypoint()

		// GET / : SSR page from the controller, Kody read from the request
		// context, middleware header applied, hydration island serialized.
		const home = await entrypoint.fetch(
			new Request(`${hostedOrigin}/`, { method: 'GET', redirect: 'manual' }),
		)
		const homeHtml = await home.text()
		expect({ status: home.status, homeHtml }).toMatchObject({ status: 200 })
		expect(home.headers.get('content-type')).toMatch(/^text\/html/)
		expect(home.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
		expect(homeHtml).toContain('<!DOCTYPE html>')
		expect(homeHtml).toContain(
			`<html lang="en" data-app-base="${appBasePath}">`,
		)
		expect(homeHtml).toContain('<h1 id="title">Remix notes</h1>')
		expect(homeHtml).toContain(`<p id="mount">Mounted at ${appBasePath}</p>`)
		expect(homeHtml).toContain(`href="${appBasePath}/_assets/styles.css"`)
		// Prefixed route contract: links stay inside the mount, including the
		// server-only layout that imports routes (and so kody:runtime).
		expect(homeHtml).toContain(`<a href="${appBasePath}/notes">Add a note</a>`)
		expect(homeHtml).toContain(
			`<nav id="nav"><a href="${appBasePath}">Home</a><a href="${appBasePath}/notes">Notes</a></nav>`,
		)
		// SSR of the clientEntry island plus its hydration record pointing at
		// the platform-served browser module rendered by the document.
		expect(homeHtml).toContain('<!-- rmx:h:')
		expect(homeHtml).toContain('id="counter"')
		expect(homeHtml).toContain('Notes: 0')
		expect(homeHtml).toContain(
			`<script type="module" src="${clientModuleUrl}">`,
		)
		expect(homeHtml).toMatch(/<script type="application\/json" id="rmx-data">/)
		expect(homeHtml).toContain('"moduleUrl":"kody:app"')
		expect(homeHtml).toContain('"exportName":"Counter"')

		// POST action: form data parsed by the formData middleware, validated
		// with data-schema, persisted through packageStorage(), then a
		// mount-aware 303 redirect.
		const created = await entrypoint.fetch(
			new Request(`${hostedOrigin}/notes`, {
				method: 'POST',
				body: new URLSearchParams({ text: '  Ship Remix mini-apps  ' }),
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				// Loader stubs follow redirects like fetch does; the host forwards
				// the browser's request, whose redirect mode is manual.
				redirect: 'manual',
			}),
		)
		expect({
			status: created.status,
			body: created.status === 303 ? null : await created.text(),
		}).toEqual({ status: 303, body: null })
		expect(created.headers.get('location')).toBe(`${appBasePath}/notes`)

		const invalid = await entrypoint.fetch(
			new Request(`${hostedOrigin}/notes`, {
				method: 'POST',
				body: new URLSearchParams({ text: '   ' }),
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				redirect: 'manual',
			}),
		)
		expect(invalid.status).toBe(400)
		expect(await invalid.text()).toContain(
			'<p id="error">A note needs some text.</p>',
		)

		const notes = await entrypoint.fetch(
			new Request(`${hostedOrigin}/notes`, {
				method: 'GET',
				redirect: 'manual',
			}),
		)
		const notesHtml = await notes.text()
		expect(notes.status).toBe(200)
		expect(notesHtml).toContain('<li>Ship Remix mini-apps</li>')
		expect(notesHtml).toContain(
			`<form method="post" action="${appBasePath}/notes">`,
		)

		// The island's props reflect the stored notes on the next home render.
		const homeAgain = await entrypoint.fetch(
			new Request(`${hostedOrigin}/`, { method: 'GET', redirect: 'manual' }),
		)
		expect(await homeAgain.text()).toContain('Notes: 1')

		// Verb routes, 404s, and 405s are the router's own behaviour.
		const health = await entrypoint.fetch(
			new Request(`${hostedOrigin}/healthz`, {
				method: 'GET',
				redirect: 'manual',
			}),
		)
		expect(await health.json()).toEqual({ ok: true })
		const missing = await entrypoint.fetch(
			new Request(`${hostedOrigin}/nope`, {
				method: 'GET',
				redirect: 'manual',
			}),
		)
		expect(missing.status).toBe(404)
		const wrongMethod = await entrypoint.fetch(
			new Request(`${hostedOrigin}/healthz`, { method: 'POST' }),
		)
		expect(wrongMethod.status).toBe(405)
	},
)

test(
	'the formData middleware key is the global FormData; importing FormData from remix/middleware/form-data fails publish',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const sourceFiles = createRemixPackageAppFiles({
			username: 'kent',
			kodyId: 'remix-notes',
		})
		const notesController = sourceFiles['app/controllers/notes.tsx'] as string
		await expect(
			buildKodyAppBundle({
				env,
				baseUrl: 'https://kody.dev',
				userId: 'user-remix-workers-test',
				sourceFiles: {
					...sourceFiles,
					'app/controllers/notes.tsx': `import { FormData } from 'remix/middleware/form-data'\n${notesController}`,
				},
				entryPoint: 'app/router.ts',
			}),
		).rejects.toThrow(/No matching export[\s\S]*"FormData"/)
	},
)

test(
	'a Remix package app browser entry bundles run() and the island into one fingerprinted module',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const sourceFiles = createRemixPackageAppFiles({
			username: 'kent',
			kodyId: 'remix-notes',
		})
		const bundle = await buildKodyAppClientBundle({
			sourceFiles,
			entryPoint: 'app/assets/entry.ts',
		})
		expect(bundle.mainModule).toMatch(packageAppClientModuleNamePattern)
		const code = bundle.modules[bundle.mainModule] as string
		// remix/ui is inlined from the platform copy; nothing bare or
		// server-only survives for the browser to resolve.
		expect(code).not.toMatch(/from\s+["']remix\//)
		expect(code).not.toMatch(/from\s+["']node:/)
		expect(code).not.toContain('kody:runtime')
		// The island and the boot are both present; JSX compiled against
		// remix/ui from the recipe's tsconfig.
		expect(code).toContain('Unknown client entry')
		expect(code).toContain('id: "counter"')
		expect(code).not.toContain('React.createElement')
		expect(code).toContain('data-rmx-')

		// The server-only boundary is enforced at publish: an island that pulls
		// the layout (which imports routes, which imports kody:runtime) into the
		// browser graph fails with the offending module named and the fix.
		await expect(
			buildKodyAppClientBundle({
				sourceFiles: {
					...sourceFiles,
					'app/ui/counter.tsx': [
						"import { clientEntry, type Handle } from 'remix/ui'",
						"import { Layout } from './layout.tsx'",
						'export const Counter = clientEntry(import.meta.url, function Counter(handle: Handle<{ label: string }>) {',
						'\treturn () => <Layout>{handle.props.label}</Layout>',
						'})',
					].join('\n'),
				},
				entryPoint: 'app/assets/entry.ts',
			}),
		).rejects.toThrow(
			/imports server-only modules that cannot run in the browser \(app\/routes\.ts: "kody:runtime"\)[\s\S]*pass that href as a prop/,
		)
	},
)

test(
	'a fetch handler that imports remix/html-template keeps the stripped path',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const bundle = await buildKodyAppBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId: 'user-remix-workers-test',
			sourceFiles: {
				'package.json': JSON.stringify({
					name: '@kent/fetch-with-remix',
					exports: { '.': './src/index.ts' },
					kody: {
						id: 'fetch-with-remix',
						description: 'fetch app that borrows html-template',
						app: { entry: './src/app.ts' },
					},
				}),
				'src/index.ts': 'export default async () => ({ ok: true })',
				'src/app.ts': [
					"import { html } from 'remix/html-template'",
					"import { createHtmlResponse } from 'remix/response/html'",
					'export default {',
					'\tasync fetch(request: Request) {',
					'\t\tconst path = new URL(request.url).pathname',
					'\t\treturn createHtmlResponse(html`<h1>${path}</h1>`)',
					'\t},',
					'}',
				].join('\n'),
			},
			entryPoint: 'src/app.ts',
		})
		const mainSource = bundle.modules[bundle.mainModule]
		expect(typeof mainSource).toBe('string')
		expect(mainSource as string).not.toContain('kody:app')
		const wrapperModule = 'test-entry.js'
		const worker = env.APP_LOADER.load({
			...createDynamicWorkerCompatibilityOptions(),
			mainModule: wrapperModule,
			modules: {
				...bundle.modules,
				[wrapperModule]: createTestWrapperSource(bundle.mainModule),
			},
		})
		const response = await worker.getEntrypoint().fetch(
			new Request(`${hostedOrigin}/hello`, {
				method: 'GET',
				redirect: 'manual',
			}),
		)
		expect(await response.text()).toContain('<h1>/hello</h1>')
	},
)
