import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	loadSearchRowsAndRegistry: vi.fn(),
	resolveSearchMemoryContext: vi.fn(
		({ query, memoryContext }: { query: string; memoryContext?: unknown }) =>
			memoryContext ?? { query },
	),
	searchUnified: vi.fn(),
	loadDownRemoteConnectorStatuses: vi.fn(async () => []),
	serializeRemoteConnectorStatus: vi.fn((status: unknown) => status),
	runPackageRetrievers: vi.fn(),
	loadRelevantMemoriesForTool: vi.fn(async () => null),
	toSlimStructuredMatches: vi.fn(
		({ matches }: { matches: unknown }) => matches,
	),
}))

vi.mock('#mcp/tools/search.ts', () => ({
	loadSearchRowsAndRegistry: (...args: Array<unknown>) =>
		mockModule.loadSearchRowsAndRegistry(...args),
	resolveSearchMemoryContext: (...args: Array<unknown>) =>
		mockModule.resolveSearchMemoryContext(...args),
	searchUnified: (...args: Array<unknown>) => mockModule.searchUnified(...args),
	loadDownRemoteConnectorStatuses: (...args: Array<unknown>) =>
		mockModule.loadDownRemoteConnectorStatuses(...args),
	serializeRemoteConnectorStatus: (...args: Array<unknown>) =>
		mockModule.serializeRemoteConnectorStatus(...args),
}))

vi.mock('#worker/package-retrievers/service.ts', () => ({
	runPackageRetrievers: (...args: Array<unknown>) =>
		mockModule.runPackageRetrievers(...args),
}))

vi.mock('#mcp/tools/memory-tool-context.ts', () => ({
	loadRelevantMemoriesForTool: (...args: Array<unknown>) =>
		mockModule.loadRelevantMemoriesForTool(...args),
}))

vi.mock('#mcp/tools/search-format.ts', () => ({
	toSlimStructuredMatches: (...args: Array<unknown>) =>
		mockModule.toSlimStructuredMatches(...args),
}))

const { searchCapability } = await import('./search.ts')

function createCtx() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
		}),
	}
}

function resetMocks() {
	mockModule.loadSearchRowsAndRegistry.mockReset()
	mockModule.resolveSearchMemoryContext.mockClear()
	mockModule.searchUnified.mockReset()
	mockModule.loadDownRemoteConnectorStatuses.mockClear()
	mockModule.runPackageRetrievers.mockReset()
	mockModule.loadRelevantMemoriesForTool.mockClear()
	mockModule.toSlimStructuredMatches.mockClear()

	mockModule.loadSearchRowsAndRegistry.mockResolvedValue({
		registry: { capabilitySpecs: {} },
		packageRows: [],
		userSecretRows: [],
		userValueRows: [],
		warnings: [],
	})
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})
	mockModule.searchUnified.mockResolvedValue({
		matches: [],
		offline: true,
	})
}

test('meta search remaps includeHiddenPackages through to package rows and search-scope retrievers', async () => {
	resetMocks()
	const ctx = createCtx()

	await searchCapability.handler({ query: 'notes' }, ctx)

	expect(mockModule.loadSearchRowsAndRegistry).toHaveBeenCalledWith(
		expect.objectContaining({
			includeHiddenPackages: false,
		}),
	)
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({
			scope: 'search',
			includeHiddenPackages: false,
		}),
	)

	resetMocks()
	await searchCapability.handler(
		{ query: 'notes', includeHiddenPackages: true },
		ctx,
	)

	expect(mockModule.loadSearchRowsAndRegistry).toHaveBeenCalledWith(
		expect.objectContaining({
			includeHiddenPackages: true,
		}),
	)
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({
			scope: 'search',
			includeHiddenPackages: true,
		}),
	)
})
