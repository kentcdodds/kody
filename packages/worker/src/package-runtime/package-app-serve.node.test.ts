import { expect, test, vi } from 'vitest'
import { servePackageAppRequest } from './package-app-serve.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
	buildPackageAppWorker: vi.fn(),
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

function createFixture() {
	const sourceId = 'source-perf-app'
	const savedPackage = {
		id: 'pkg-perf-app',
		userId: 'user-1',
		name: '@kentcdodds/perf-app',
		kodyId: 'perf-app',
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
		repo_id: 'repo-perf-app',
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
		name: '@kentcdodds/perf-app',
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'perf-app',
			description: 'Minimal hello-world app',
			app: { entry: './src/app.ts' },
		},
	})
	return { savedPackage, source, manifestContent }
}

function seedFixture() {
	const fixture = createFixture()
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

async function serveHelloWorld() {
	return await servePackageAppRequest({
		request: new Request('https://example.com/@kentcdodds/packages/perf-app'),
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
			kodyId: 'perf-app',
			restPath: '/',
			mount: 'username-path',
		},
	})
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
