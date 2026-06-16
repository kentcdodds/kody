import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	buildSavedPackageSearchRows: vi.fn(),
	getCapabilityRegistryForContext: vi.fn(),
	listSavedPackagesByUserId: vi.fn(),
	listUserSecretsForSearch: vi.fn(),
	listValues: vi.fn(),
	loadDownRemoteConnectorStatuses: vi.fn(),
	loadOptionalSearchRows: vi.fn(),
	loadRelevantMemoriesForTool: vi.fn(),
	resolveSearchMemoryContext: vi.fn(),
	runModuleWithRegistry: vi.fn(),
	runPackageRetrievers: vi.fn(),
	searchUnified: vi.fn(),
	toSlimStructuredMatches: vi.fn(),
}))

vi.mock('#mcp/run-codemode-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		mockModule.runModuleWithRegistry(...args),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (...args: Array<unknown>) =>
		mockModule.getCapabilityRegistryForContext(...args),
}))

vi.mock('#mcp/tools/search.ts', () => ({
	buildSavedPackageSearchRows: (...args: Array<unknown>) =>
		mockModule.buildSavedPackageSearchRows(...args),
	loadDownRemoteConnectorStatuses: (...args: Array<unknown>) =>
		mockModule.loadDownRemoteConnectorStatuses(...args),
	loadOptionalSearchRows: (...args: Array<unknown>) =>
		mockModule.loadOptionalSearchRows(...args),
	resolveSearchMemoryContext: (...args: Array<unknown>) =>
		mockModule.resolveSearchMemoryContext(...args),
	searchUnified: (...args: Array<unknown>) => mockModule.searchUnified(...args),
}))

vi.mock('#mcp/tools/search-format.ts', () => ({
	toSlimStructuredMatches: (...args: Array<unknown>) =>
		mockModule.toSlimStructuredMatches(...args),
}))

vi.mock('#mcp/tools/memory-tool-context.ts', () => ({
	loadRelevantMemoriesForTool: (...args: Array<unknown>) =>
		mockModule.loadRelevantMemoriesForTool(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-retrievers/service.ts', () => ({
	runPackageRetrievers: (...args: Array<unknown>) =>
		mockModule.runPackageRetrievers(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: (...args: Array<unknown>) =>
		mockModule.listUserSecretsForSearch(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	listValues: (...args: Array<unknown>) => mockModule.listValues(...args),
}))

const { executeCapability } = await import('./execute.ts')
const { searchCapability } = await import('./search.ts')

test('execute capability runs modules through the shared execute runtime', async () => {
	vi.clearAllMocks()
	mockModule.runModuleWithRegistry.mockResolvedValue({
		result: { marker: 'execute-ok' },
		logs: [{ level: 'info', message: 'ran' }],
	})

	const result = await executeCapability.handler(
		{
			code: 'export default async function main() { return { marker: "execute-ok" } }',
			storageId: 'package:agent-turns',
			writable: true,
			conversationId: 'conv-execute',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'User',
				},
			}),
		},
	)

	expect(result).toMatchObject({
		ok: true,
		conversationId: 'conv-execute',
		storage: { id: 'package:agent-turns' },
		result: { marker: 'execute-ok' },
		logs: [{ level: 'info', message: 'ran' }],
	})
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			storageContext: {
				sessionId: null,
				appId: null,
				storageId: 'package:agent-turns',
			},
		}),
		expect.stringContaining('execute-ok'),
		undefined,
		{
			storageTools: {
				userId: 'user-1',
				storageId: 'package:agent-turns',
				writable: true,
			},
		},
	)
})

test('search capability returns shared slim structured search matches', async () => {
	vi.clearAllMocks()
	const registry = { capabilitySpecs: { package_save: {} } }
	const optionalRows = {
		packageRows: [],
		userSecretRows: [],
		userValueRows: [],
		warnings: ['row warning'],
	}
	const rawMatches = [{ type: 'capability', id: 'package_save' }]
	const slimMatches = [
		{
			type: 'capability',
			id: 'package_save',
			entityRef: 'package_save:capability',
			title: 'package_save',
			description: 'Create or replace a saved package.',
			usage: 'codemode.package_save(...)',
		},
	]
	mockModule.getCapabilityRegistryForContext.mockResolvedValue(registry)
	mockModule.loadOptionalSearchRows.mockResolvedValue(optionalRows)
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [{ id: 'retriever-result' }],
		warnings: ['retriever warning'],
	})
	mockModule.resolveSearchMemoryContext.mockReturnValue({
		query: 'package_save',
	})
	mockModule.searchUnified.mockResolvedValue({
		matches: rawMatches,
		offline: false,
		guidance: 'Use package_save.',
	})
	mockModule.loadDownRemoteConnectorStatuses.mockResolvedValue([
		{
			connectorKind: 'home',
			connectorId: 'default',
			state: 'disconnected',
			connected: false,
			toolCount: 0,
		},
	])
	mockModule.loadRelevantMemoriesForTool.mockResolvedValue({
		memories: [],
		suppressedCount: 0,
		retrievalQuery: 'package_save',
		retrieverResults: [],
		retrieverWarnings: ['memory warning'],
	})
	mockModule.toSlimStructuredMatches.mockReturnValue(slimMatches)

	const result = await searchCapability.handler(
		{
			query: 'package_save',
			limit: 5,
			conversationId: 'conv-search',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'User',
				},
			}),
		},
	)

	expect(result).toEqual({
		conversationId: 'conv-search',
		matches: slimMatches,
		offline: false,
		warnings: ['row warning', 'retriever warning', 'memory warning'],
		guidance: expect.any(String),
		memories: {
			surfaced: [],
			suppressedCount: 0,
			retrievalQuery: 'package_save',
			retrieverResults: [],
			retrieverWarnings: ['memory warning'],
		},
		remoteConnectorStatuses: [
			{
				connectorKind: 'home',
				connectorId: 'default',
				state: 'disconnected',
				connected: false,
				toolCount: 0,
			},
		],
	})
	expect(mockModule.searchUnified).toHaveBeenCalledWith({
		env: {},
		query: 'package_save',
		limit: 5,
		registry,
		optionalRows: {
			registry,
			...optionalRows,
		},
		retrieverResults: [{ id: 'retriever-result' }],
	})
	expect(mockModule.toSlimStructuredMatches).toHaveBeenCalledWith({
		matches: rawMatches,
		baseUrl: 'https://heykody.dev',
	})
})
