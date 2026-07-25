import { expect, test, vi } from 'vitest'

const mockFns = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getEntitySourceById: vi.fn(),
	listPackageRetrieversForScope: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: mockFns.getSavedPackageById,
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockFns.getEntitySourceById,
}))

vi.mock('#worker/package-retrievers/manifest-cache.ts', () => ({
	listPackageRetrieversForScope: mockFns.listPackageRetrieversForScope,
}))

function createHiddenRetrieverFixture(scopes: Array<'search' | 'context'>) {
	return {
		entry: {
			userId: 'user-1',
			packageId: 'pkg-hidden',
			kodyId: 'hidden-pkg',
			sourceId: 'source-hidden',
			revision: 'commit-1',
			retrieverKey: 'notes',
			exportName: './notes',
			entryPoint: './notes.ts',
			name: 'Notes',
			description: 'Notes retriever',
			scopes,
			timeoutMs: null,
			maxResults: null,
		},
		hiddenPackage: {
			id: 'pkg-hidden',
			userId: 'user-1',
			name: 'hidden-pkg',
			kodyId: 'hidden-pkg',
			description: 'hidden package',
			tags: [],
			searchText: 'hidden',
			sourceId: 'source-hidden',
			hasApp: false,
			hidden: true,
			isPrivate: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	}
}

test('hidden package retrievers skip search by default, honor includeHiddenPackages, and still run for context', async () => {
	const { entry, hiddenPackage } = createHiddenRetrieverFixture(['search'])
	mockFns.listPackageRetrieversForScope.mockResolvedValue([entry])
	mockFns.getSavedPackageById.mockResolvedValue(hiddenPackage)
	mockFns.getEntitySourceById.mockResolvedValue(null)

	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')

	const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env

	const excluded = await runPackageRetrievers({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		scope: 'search',
		query: 'notes',
	})
	expect(excluded.results).toEqual([])
	expect(mockFns.getEntitySourceById).not.toHaveBeenCalled()

	const included = await runPackageRetrievers({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		scope: 'search',
		query: 'notes',
		includeHiddenPackages: true,
	})
	expect(included.results).toEqual([])
	expect(mockFns.getEntitySourceById).toHaveBeenCalledWith(
		env.APP_DB,
		'source-hidden',
	)

	const { entry: contextEntry } = createHiddenRetrieverFixture(['context'])
	mockFns.listPackageRetrieversForScope.mockResolvedValue([contextEntry])
	mockFns.getEntitySourceById.mockClear()

	const contextRun = await runPackageRetrievers({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		scope: 'context',
		query: 'notes',
	})
	expect(contextRun.results).toEqual([])
	expect(mockFns.getEntitySourceById).toHaveBeenCalledWith(
		env.APP_DB,
		'source-hidden',
	)
	// The dynamic import above pulls in the retriever service module graph, and a
	// cold transform of it can exceed the 5s default when the worker pool is
	// saturated (the suite spends far longer importing than running). Same
	// allowance as search-handler.node.test.ts, which imports the same graph.
}, 10_000)
