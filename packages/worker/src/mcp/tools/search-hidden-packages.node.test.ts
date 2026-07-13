import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockFns = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(async () => ({
		capabilitySpecs: {},
	})),
	listUserSecretsForSearch: vi.fn(async () => []),
	listValues: vi.fn(async () => []),
	loadRelevantMemoriesForTool: vi.fn(async () => null),
	getSavedPackageById: vi.fn(),
	getEntitySourceById: vi.fn(),
	listPackageRetrieversForScope: vi.fn(),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: mockFns.getCapabilityRegistryForContext,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mockFns.listSavedPackagesByUserId,
	getSavedPackageById: mockFns.getSavedPackageById,
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockFns.getEntitySourceById,
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: mockFns.listUserSecretsForSearch,
}))

vi.mock('#mcp/values/service.ts', () => ({
	listValues: mockFns.listValues,
}))

vi.mock('#mcp/tools/memory-tool-context.ts', () => ({
	loadRelevantMemoriesForTool: mockFns.loadRelevantMemoriesForTool,
}))

vi.mock('#worker/package-retrievers/manifest-cache.ts', () => ({
	listPackageRetrieversForScope: mockFns.listPackageRetrieversForScope,
}))

function createPackages() {
	return [
		{
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
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		{
			id: 'pkg-visible',
			userId: 'user-1',
			name: 'visible-pkg',
			kodyId: 'visible-pkg',
			description: 'visible package',
			tags: [],
			searchText: 'visible',
			sourceId: 'source-visible',
			hasApp: false,
			hidden: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	]
}

test('search default excludes hidden packages; includeHiddenPackages includes them', async () => {
	mockFns.listSavedPackagesByUserId.mockResolvedValueOnce(createPackages())

	const { loadSearchRowsAndRegistry } = await import('#mcp/tools/search.ts')

	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
		},
		remoteConnectors: [],
	})
	const env = { APP_DB: {} } as Env

	const rowsDefault = await loadSearchRowsAndRegistry({
		env,
		callerContext,
		userId: 'user-1',
	})

	expect(rowsDefault.packageRows.map((r) => r.record.kodyId)).toEqual([
		'visible-pkg',
	])

	mockFns.listSavedPackagesByUserId.mockResolvedValueOnce(createPackages())

	const rowsInclude = await loadSearchRowsAndRegistry({
		env,
		callerContext,
		userId: 'user-1',
		includeHiddenPackages: true,
	})

	expect(rowsInclude.packageRows.map((r) => r.record.kodyId).sort()).toEqual([
		'hidden-pkg',
		'visible-pkg',
	])
})

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
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	}
}

test('hidden package retrievers are skipped by default for search and allowed when includeHiddenPackages is set', async () => {
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
})

test('context-scope package retrievers still run for hidden packages without includeHiddenPackages', async () => {
	const { entry, hiddenPackage } = createHiddenRetrieverFixture(['context'])
	mockFns.listPackageRetrieversForScope.mockResolvedValue([entry])
	mockFns.getSavedPackageById.mockResolvedValue(hiddenPackage)
	mockFns.getEntitySourceById.mockResolvedValue(null)

	const { runPackageRetrievers } =
		await import('#worker/package-retrievers/service.ts')

	const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env

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
})
