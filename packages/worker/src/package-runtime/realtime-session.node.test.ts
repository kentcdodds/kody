import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	buildPackageAppWorker: vi.fn(),
	createMcpCallerContext: vi.fn(),
	buildFacetName: vi.fn((value?: string | null) => value ?? 'default'),
	getSavedPackageById: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#mcp/context.ts', () => ({
	createMcpCallerContext: (...args: Array<unknown>) =>
		mockModule.createMcpCallerContext(...args),
}))

vi.mock('#mcp/app-runner-facet-names.ts', () => ({
	buildFacetName: (...args: Array<unknown>) => mockModule.buildFacetName(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./package-app.ts', () => ({
	buildPackageAppWorker: (...args: Array<unknown>) =>
		mockModule.buildPackageAppWorker(...args),
}))

const {
	PackageRealtimeSession,
	resolvePackageAppWorkerCacheKey,
} = await import('./realtime-session.ts')

test('resolvePackageAppWorkerCacheKey includes latest published commit when available', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-2',
		indexed_commit: 'commit-2',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	})

	const cacheKey = await resolvePackageAppWorkerCacheKey({
		env: {
			APP_DB: {} as D1Database,
		} as Env,
		binding: {
			userId: 'user-1',
			packageId: 'package-1',
			kodyId: 'example',
			sourceId: 'source-1',
			baseUrl: 'https://example.com',
		},
	})

	expect(cacheKey).toBe(
		JSON.stringify([
			'user-1',
			'package-1',
			'source-1',
			'https://example.com',
			'commit-2',
		]),
	)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledWith({}, 'source-1')
})

test('resolvePackageAppWorkerCacheKey falls back to current source state when published commit is unavailable', async () => {
	mockModule.getEntitySourceById.mockReset()
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
	})

	const cacheKey = await resolvePackageAppWorkerCacheKey({
		env: {
			APP_DB: {} as D1Database,
		} as Env,
		binding: {
			userId: 'user-1',
			packageId: 'package-1',
			kodyId: 'example',
			sourceId: 'source-1',
			baseUrl: 'https://example.com',
		},
	})

	expect(cacheKey).toBe(
		JSON.stringify([
			'user-1',
			'package-1',
			'source-1',
			'https://example.com',
			null,
		]),
	)
})

test('PackageRealtimeSession is exported for runtime consumers', () => {
	expect(PackageRealtimeSession).toBeDefined()
})
