import { expect, test, vi } from 'vitest'
import type * as PackageSourceModule from '#worker/package-registry/source.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { servePackageAppRequest } from './package-app-serve.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
	buildPackageAppWorker: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	persistPublishedBundleArtifact: vi.fn(),
	createWorker: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', async () => {
	const actual = await vi.importActual<typeof PackageSourceModule>(
		'#worker/package-registry/source.ts',
	)
	return {
		...actual,
		loadPackageSourceBySourceId: (...args: Array<unknown>) =>
			mockModule.loadPackageSourceBySourceId(...args),
	}
})

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		mockModule.loadPublishedBundleArtifactByIdentity(...args),
	persistPublishedBundleArtifact: (...args: Array<unknown>) =>
		mockModule.persistPublishedBundleArtifact(...args),
}))

vi.mock('#worker/worker-bundler-modules.ts', () => ({
	importWorkerBundler: async () => ({
		createWorker: (...args: Array<unknown>) => mockModule.createWorker(...args),
	}),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntityManifest(...args),
	loadPublishedEntitySource: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-app.ts', () => ({
	createPackageAppCallerContext: async (input: {
		user: { userId: string; email: string; displayName: string }
	}) => ({
		user: input.user,
	}),
	buildPackageAppWorker: (...args: Array<unknown>) =>
		mockModule.buildPackageAppWorker(...args),
}))

const serveLoadMocks = [
	['saved package by id (D1)', mockModule.getSavedPackageById],
	['saved package by kody id (D1)', mockModule.getSavedPackageByKodyId],
	['entity source row (D1)', mockModule.getEntitySourceById],
	['published manifest snapshot (KV)', mockModule.loadPublishedEntityManifest],
] as const

function countServeLoads() {
	return Object.fromEntries(
		serveLoadMocks.map(([label, mock]) => [label, mock.mock.calls.length]),
	)
}

function clearServeLoadCounters() {
	for (const [, mock] of serveLoadMocks) {
		mock.mockClear()
	}
}

type FixtureOptions = {
	kodyId?: string
	app?: Record<string, string>
}

function createFixture(options: FixtureOptions = {}) {
	const kodyId = options.kodyId ?? 'perf-app'
	const app = options.app ?? { entry: './src/app.ts' }
	const sourceId = `source-${kodyId}`
	const savedPackage = {
		id: `pkg-${kodyId}`,
		userId: 'user-1',
		name: `@kentcdodds/${kodyId}`,
		kodyId,
		description: 'Minimal hello-world app',
		tags: [],
		searchText: null,
		sourceId,
		hasApp: true,
		hidden: true,
		isPrivate: true,
		createdAt: '2026-08-12T00:00:00.000Z',
		updatedAt: '2026-08-12T00:00:00.000Z',
	}
	const source = {
		id: sourceId,
		user_id: 'user-1',
		entity_kind: 'package' as const,
		entity_id: savedPackage.id,
		repo_id: `repo-${kodyId}`,
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-08-12T00:00:00.000Z',
		updated_at: '2026-08-12T00:00:00.000Z',
	}
	const manifestContent = JSON.stringify({
		name: `@kentcdodds/${kodyId}`,
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			id: kodyId,
			description: 'Minimal hello-world app',
			app,
		},
	})
	return { savedPackage, source, manifestContent }
}

function seedFixture(options?: FixtureOptions) {
	const fixture = createFixture(options)
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.getSavedPackageByKodyId.mockImplementation(
		async (_db: unknown, input: { userId: string; kodyId: string }) =>
			input.userId === fixture.savedPackage.userId &&
			input.kodyId === fixture.savedPackage.kodyId
				? fixture.savedPackage
				: null,
	)
	mockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) =>
			sourceId === fixture.source.id ? fixture.source : null,
	)
	mockModule.loadPublishedEntityManifest.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId !== fixture.source.id) {
				throw new Error(`No manifest for ${input.sourceId}`)
			}
			return { source: fixture.source, content: fixture.manifestContent }
		},
	)
	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		stub: {
			getEntrypoint: () => ({
				async fetch() {
					return new Response('ok')
				},
			}),
		},
	})
	return fixture
}

async function serveHelloWorld(input?: {
	kodyId?: string
	restPath?: string
	init?: RequestInit
	dispatch?: { synthetic: true }
}) {
	const kodyId = input?.kodyId ?? 'perf-app'
	const restPath = input?.restPath ?? '/'
	return await servePackageAppRequest({
		request: new Request(
			`https://example.com/@kentcdodds/packages/${kodyId}${restPath === '/' ? '' : restPath}`,
			input?.init,
		),
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as Env,
		owner: {
			userId: 'user-1',
			username: 'kentcdodds',
			email: 'kent@example.com',
			displayName: 'Kent',
		},
		packagePath: {
			username: 'kentcdodds',
			kodyId,
			restPath,
			mount: 'username-path',
		},
		dispatch: input?.dispatch,
	})
}

const clientModuleName = 'client.0123456789abcdef.js'

const clientAppKodyId = 'client-app'

function seedClientAndAssets() {
	const fixture = seedFixture({
		kodyId: clientAppKodyId,
		app: {
			entry: './src/app.ts',
			client: './src/client.ts',
			assets: './public',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockReset()
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { kind: string; entryPoint: string }) =>
			input.kind === 'app-client' && input.entryPoint === 'src/client.ts'
				? {
						row: { id: 'row-client' },
						artifact: {
							mainModule: clientModuleName,
							modules: { [clientModuleName]: 'export const hello = "hi"' },
						},
					}
				: null,
	)
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: fixture.source,
		manifest: JSON.parse(fixture.manifestContent),
		files: {
			'package.json': fixture.manifestContent,
			'src/app.ts': 'export default { fetch() { return new Response("ok") } }',
			'src/client.ts': 'export const hello = "hi"',
			'public/styles.css': 'body { color: red }',
			'public/img/dot.png': '\u0089PNG\r\n\u001a\n',
			'public/client.production.js': 'console.log("static, not the bundle")',
		},
	})
	return fixture
}

test('a warm package-app serve performs zero D1/KV loads before dispatch', async () => {
	seedFixture()

	const cold = await serveHelloWorld()
	expect(cold.status).toBe(200)
	expect(await cold.text()).toBe('ok')
	expect(mockModule.getSavedPackageByKodyId).toHaveBeenCalledTimes(1)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(1)
	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledTimes(1)
	expect(mockModule.buildPackageAppWorker).toHaveBeenCalledTimes(1)

	clearServeLoadCounters()
	mockModule.buildPackageAppWorker.mockClear()
	const warm = await serveHelloWorld()

	expect(warm.status).toBe(200)
	expect(await warm.text()).toBe('ok')
	expect(countServeLoads()).toEqual({
		'saved package by id (D1)': 0,
		'saved package by kody id (D1)': 0,
		'entity source row (D1)': 0,
		'published manifest snapshot (KV)': 0,
	})
	expect(mockModule.buildPackageAppWorker).toHaveBeenCalledTimes(1)
})

test('/_assets/ serves the fingerprinted client module with immutable caching and never builds the worker', async () => {
	seedClientAndAssets()
	mockModule.buildPackageAppWorker.mockClear()

	const response = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: `/_assets/${clientModuleName}`,
	})
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe(
		'text/javascript; charset=utf-8',
	)
	expect(response.headers.get('Cache-Control')).toBe(
		'private, max-age=31536000, immutable',
	)
	expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
	expect(response.headers.get('ETag')).toBe(`"${clientModuleName}"`)
	expect(await response.text()).toBe('export const hello = "hi"')
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()

	const revalidated = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: `/_assets/${clientModuleName}`,
		init: { headers: { 'If-None-Match': `"${clientModuleName}"` } },
	})
	expect(revalidated.status).toBe(304)

	const stale = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: '/_assets/client.ffffffffffffffff.js',
	})
	expect(stale.status).toBe(404)
	expect(stale.headers.get('Cache-Control')).toBe('no-store')

	// A static file whose name merely resembles a client module is not
	// shadowed by the fingerprinted-module fast path.
	const lookalike = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: '/_assets/client.production.js',
	})
	expect(lookalike.status).toBe(200)
	expect(lookalike.headers.get('Content-Type')).toBe(
		'text/javascript; charset=utf-8',
	)
	expect(lookalike.headers.get('Cache-Control')).toBe('private, max-age=300')
	expect(await lookalike.text()).toBe('console.log("static, not the bundle")')
	// A service worker script in the assets directory may claim the whole app
	// mount as its scope; non-script assets do not carry the header.
	expect(lookalike.headers.get('Service-Worker-Allowed')).toBe(
		'/@kentcdodds/packages/client-app/',
	)
	expect(response.headers.get('Service-Worker-Allowed')).toBeNull()
	const css = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: '/_assets/styles.css',
	})
	expect(css.headers.get('Service-Worker-Allowed')).toBeNull()
})

test('/_assets/__version.json exposes the current client module URL for service workers without caching', async () => {
	const fixture = seedClientAndAssets()
	mockModule.buildPackageAppWorker.mockClear()

	const version = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: '/_assets/__version.json',
	})
	expect(version.status).toBe(200)
	expect(version.headers.get('Content-Type')).toBe(
		'application/json; charset=utf-8',
	)
	expect(version.headers.get('Cache-Control')).toBe('private, no-cache')
	expect(version.headers.get('ETag')).toBe(
		`"${fixture.source.published_commit}:${clientModuleName}"`,
	)
	expect(await version.json()).toEqual({
		clientModuleUrl: `https://example.com/@kentcdodds/packages/${clientAppKodyId}/_assets/${clientModuleName}`,
		assetBasePath: `/@kentcdodds/packages/${clientAppKodyId}/_assets`,
		publishedCommit: fixture.source.published_commit,
	})
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()

	// Worker-only apps still answer, with a null module URL, so kit code can
	// probe one path regardless of manifest shape.
	seedFixture()
	const workerOnly = await serveHelloWorld({
		restPath: '/_assets/__version.json',
	})
	expect(workerOnly.status).toBe(200)
	expect(await workerOnly.json()).toMatchObject({
		clientModuleUrl: null,
		assetBasePath: '/@kentcdodds/packages/perf-app/_assets',
	})
})

test('/_assets/ serves files from the declared assets directory with inferred content types', async () => {
	const fixture = seedClientAndAssets()
	mockModule.buildPackageAppWorker.mockClear()

	const css = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: '/_assets/styles.css',
	})
	expect(css.status).toBe(200)
	expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
	expect(css.headers.get('Cache-Control')).toBe('private, max-age=300')
	expect(css.headers.get('ETag')).toBe(
		`"${fixture.source.published_commit}:public/styles.css"`,
	)
	expect(await css.text()).toBe('body { color: red }')

	const png = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: '/_assets/img/dot.png',
	})
	expect(png.status).toBe(200)
	expect(png.headers.get('Content-Type')).toBe('image/png')
	expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	])

	const head = await serveHelloWorld({
		kodyId: clientAppKodyId,
		restPath: '/_assets/styles.css',
		init: { method: 'HEAD' },
	})
	expect(head.status).toBe(200)
	expect(head.headers.get('Content-Length')).toBe('19')
	expect(await head.text()).toBe('')

	expect(
		(
			await serveHelloWorld({
				kodyId: clientAppKodyId,
				restPath: '/_assets/missing.txt',
			})
		).status,
	).toBe(404)
	expect(
		(
			await serveHelloWorld({
				kodyId: clientAppKodyId,
				restPath: '/_assets/../package.json',
			})
		).status,
	).toBe(404)
	expect(
		(
			await serveHelloWorld({
				kodyId: clientAppKodyId,
				restPath: '/_assets/%2e%2e/package.json',
			})
		).status,
	).toBe(404)
	expect(
		(
			await serveHelloWorld({
				kodyId: clientAppKodyId,
				restPath: '/_assets/styles.css',
				init: { method: 'POST' },
			})
		).status,
	).toBe(405)
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})

test('/_assets/ repairs a missing published client artifact from fresh source and persists it under the fresh row', async () => {
	const repairKodyId = 'repair-app'
	const fixture = seedFixture({
		kodyId: repairKodyId,
		app: { entry: './src/app.ts', client: './src/client.ts' },
	})
	// The cached manifest still says ./src/client.ts; the source files (and
	// the D1 row) have moved on to a republish that renamed the entry.
	const freshSource = { ...fixture.source, published_commit: 'commit-2' }
	const freshManifestContent = JSON.stringify({
		...JSON.parse(fixture.manifestContent),
		kody: {
			...JSON.parse(fixture.manifestContent).kody,
			app: { entry: './src/app.ts', client: './src/browser.ts' },
		},
	})
	mockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) =>
			sourceId === fixture.source.id ? freshSource : null,
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockReset()
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.persistPublishedBundleArtifact.mockReset()
	mockModule.persistPublishedBundleArtifact.mockResolvedValue('kv-key')
	mockModule.createWorker.mockReset()
	mockModule.createWorker.mockResolvedValue({
		mainModule: 'bundle.js',
		modules: { 'bundle.js': 'console.log("rebuilt");\n' },
	})
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: freshSource,
		manifest: JSON.parse(freshManifestContent),
		files: {
			'package.json': freshManifestContent,
			'src/app.ts': 'export default { fetch() { return new Response("ok") } }',
			'src/browser.ts': 'console.log("rebuilt")',
		},
	})

	const probe = await serveHelloWorld({
		kodyId: repairKodyId,
		restPath: '/_assets/client.0000000000000000.js',
	})
	// The requested hash is stale, but the repair still happens so the next
	// page render can hand out the fresh URL.
	expect(probe.status).toBe(404)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(mockModule.createWorker).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/browser.ts' }),
	)
	expect(mockModule.persistPublishedBundleArtifact).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: 'app-client',
			artifactName: null,
			entryPoint: 'src/browser.ts',
			source: freshSource,
			mainModule: expect.stringMatching(/^client\.[A-Za-z0-9_-]{16}\.js$/),
		}),
	)
	const persisted = mockModule.persistPublishedBundleArtifact.mock
		.calls[0]?.[0] as { mainModule: string }

	const served = await serveHelloWorld({
		kodyId: repairKodyId,
		restPath: `/_assets/${persisted.mainModule}`,
	})
	expect(served.status).toBe(200)
	expect(await served.text()).toBe('console.log("rebuilt");\n')
	// Warm: the artifact cache answers without another bundle or KV lookup.
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(1)
})

test('/_assets/ treats a client entry removed by a republish as no client', async () => {
	const removedKodyId = 'removed-client-app'
	const fixture = seedFixture({
		kodyId: removedKodyId,
		app: { entry: './src/app.ts', client: './src/client.ts' },
	})
	const freshManifestContent = JSON.stringify({
		...JSON.parse(fixture.manifestContent),
		kody: {
			...JSON.parse(fixture.manifestContent).kody,
			app: { entry: './src/app.ts' },
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockReset()
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.persistPublishedBundleArtifact.mockReset()
	mockModule.createWorker.mockReset()
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: fixture.source,
		manifest: JSON.parse(freshManifestContent),
		files: {
			'package.json': freshManifestContent,
			'src/app.ts': 'export default { fetch() { return new Response("ok") } }',
		},
	})

	const response = await serveHelloWorld({
		kodyId: removedKodyId,
		restPath: '/_assets/client.0000000000000000.js',
	})
	expect(response.status).toBe(404)
	expect(mockModule.createWorker).not.toHaveBeenCalled()
	expect(mockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
})

test('/_assets/ is a 404 for apps without client or assets and author fetch still handles other paths', async () => {
	seedFixture()
	mockModule.loadPublishedBundleArtifactByIdentity.mockReset()
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.buildPackageAppWorker.mockClear()

	const asset = await serveHelloWorld({ restPath: '/_assets/anything.js' })
	expect(asset.status).toBe(404)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).not.toHaveBeenCalled()
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()

	const page = await serveHelloWorld({ restPath: '/assets/anything.js' })
	expect(page.status).toBe(200)
	expect(await page.text()).toBe('ok')
	expect(mockModule.buildPackageAppWorker).toHaveBeenCalledTimes(1)
})

test('published leftover kody.app.runtime does not brick host-setup', async () => {
	seedFixture({
		kodyId: 'legacy-runtime-app',
		app: { entry: './src/app.ts', runtime: 'remix' },
	})

	const response = await serveHelloWorld({ kodyId: 'legacy-runtime-app' })
	expect(response.status).toBe(200)
	expect(await response.text()).toBe('ok')
	expect(mockModule.buildPackageAppWorker).toHaveBeenCalled()
})

test('synthetic host-setup failures return JSON with the underlying cause', async () => {
	consoleError.mockImplementation(() => {})
	seedFixture({ kodyId: 'prep-fail-app' })
	mockModule.buildPackageAppWorker.mockRejectedValueOnce(
		new Error(
			'kody.app.runtime was removed; request dispatch is by export shape',
		),
	)

	const response = await serveHelloWorld({
		kodyId: 'prep-fail-app',
		dispatch: { synthetic: true },
	})
	expect(response.status).toBe(500)
	expect(response.headers.get('content-type')).toContain('application/json')
	await expect(response.json()).resolves.toEqual({
		error: 'Package app could not be prepared',
		message:
			'Kody could not load or prepare this package app runtime before your request reached the package code.',
		next_step:
			'This has been reported to Kody. Try again shortly, or ask the package owner to republish the package if it keeps happening.',
		package: {
			name: '@kentcdodds/prep-fail-app',
			kody_id: 'prep-fail-app',
		},
		request_path: '/@kentcdodds/packages/prep-fail-app',
		cause: 'kody.app.runtime was removed; request dispatch is by export shape',
	})
})
