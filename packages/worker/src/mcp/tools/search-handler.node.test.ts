import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getCapabilityRegistryForContext: vi.fn(async () => ({
		capabilitySpecs: {
			search_docs: {
				name: 'search_docs',
				description: 'Search docs capability',
				domain: 'meta',
				keywords: [],
				inputFields: [],
				requiredInputFields: [],
				outputFields: [],
				readOnly: true,
				idempotent: true,
				destructive: false,
				inputSchema: { type: 'object', properties: {} },
			},
		},
	})),
	listSavedPackagesByUserId: vi.fn(async () => []),
	listUserSecretsForSearch: vi.fn(async () => []),
	listValues: vi.fn(async () => []),
	loadRelevantMemoriesForTool: vi.fn(async () => null),
	getRemoteConnectorStatus: vi.fn(async () => ({
		connectorKind: 'home',
		connectorId: 'default',
		state: 'connected',
		connected: true,
		toolCount: 1,
	})),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mockModule.getCapabilityRegistryForContext(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByKodyId: vi.fn(),
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: (...args: Array<unknown>) =>
		mockModule.listUserSecretsForSearch(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	listValues: (...args: Array<unknown>) => mockModule.listValues(...args),
}))

vi.mock('./memory-tool-context.ts', async () => {
	const actual = await vi.importActual('./memory-tool-context.ts')
	return {
		...actual,
		loadRelevantMemoriesForTool: (...args: Array<unknown>) =>
			mockModule.loadRelevantMemoriesForTool(...args),
	}
})

vi.mock('#worker/home/status.ts', () => ({
	getRemoteConnectorStatus: (...args: Array<unknown>) =>
		mockModule.getRemoteConnectorStatus(...args),
}))

const { registerSearchTool } = await import('./search.ts')

const mockPerformanceNow = vi.spyOn(performance, 'now')

async function getSearchHandler() {
	const registerTool = vi.fn()

	await registerSearchTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(() => ({})),
		getCallerContext: vi.fn(() => ({
			baseUrl: 'https://example.com',
			user: null,
			homeConnectorId: 'default',
			remoteConnectors: null,
		})),
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	const [name, , handler] = registerTool.mock.calls[0] ?? []
	expect(name).toBe('search')
	expect(typeof handler).toBe('function')
	return handler as (input: {
		query?: string
		entity?: string
		limit?: number
		conversationId?: string
	}) => Promise<{
		structuredContent: {
			conversationId: string
			timing: {
				startedAt: string
				endedAt: string
				durationMs: number
			}
			error?: string
			result?: unknown
		}
		isError?: boolean
	}>
}

test('search tool reports timing metadata across success and error flows', async () => {
	vi.clearAllMocks()
	const handler = await getSearchHandler()

	mockPerformanceNow.mockReturnValueOnce(100).mockReturnValueOnce(112)
	const successResponse = await handler({
		query: 'search docs',
		conversationId: 'conv-search',
	})
	expect(successResponse.isError).toBeUndefined()
	expect(successResponse.structuredContent).toMatchObject({
		conversationId: 'conv-search',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 12,
		},
	})

	mockPerformanceNow.mockReturnValueOnce(5).mockReturnValueOnce(9)
	const validationErrorResponse = await handler({
		conversationId: 'conv-search-error',
	})
	expect(validationErrorResponse.isError).toBe(true)
	expect(validationErrorResponse.structuredContent).toEqual({
		conversationId: 'conv-search-error',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 4,
		},
		error: 'Provide either "query" or "entity".',
	})

	mockModule.getCapabilityRegistryForContext.mockRejectedValueOnce(
		new Error('Registry unavailable'),
	)
	mockPerformanceNow.mockReturnValueOnce(20).mockReturnValueOnce(35)
	const handledErrorResponse = await handler({
		query: 'search docs',
		conversationId: 'conv-search-handled-error',
	})
	expect(handledErrorResponse.isError).toBe(true)
	expect(handledErrorResponse.structuredContent).toEqual({
		conversationId: 'conv-search-handled-error',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: 15,
		},
		error: 'Registry unavailable',
	})
})
