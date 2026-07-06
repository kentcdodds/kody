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
		connectorId: 'home',
		state: 'connected',
		connected: true,
		toolCount: 1,
		message: 'connected',
		error: null,
		connectedAt: null,
		lastSeenAt: null,
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

vi.mock('#worker/remote-connector/status.ts', () => ({
	getRemoteConnectorStatus: (...args: Array<unknown>) =>
		mockModule.getRemoteConnectorStatus(...args),
}))

const { registerSearchTool } = await import('./search.ts')

const mockPerformanceNow = vi.spyOn(performance, 'now')

async function getSearchRegistration() {
	const registerTool = vi.fn()

	await registerSearchTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(() => ({})),
		getCallerContext: vi.fn(() => ({
			baseUrl: 'https://example.com',
			user: null,
			remoteConnectors: [{ instanceId: 'home' }],
		})),
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	const [name, , handler] = registerTool.mock.calls[0] ?? []
	expect(name).toBe('search')
	return { handler }
}

async function getSearchHandler() {
	const { handler } = await getSearchRegistration()
	return handler as (input: {
		query?: string
		entity?: string
		limit?: number
		maxResponseSize?: number
		conversationId?: string
	}) => Promise<{
		content: Array<{
			type: 'text'
			text: string
		}>
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

test('search tool returns compact query markdown while preserving structured auxiliary detail', async () => {
	vi.clearAllMocks()
	mockModule.loadRelevantMemoriesForTool.mockResolvedValueOnce({
		memories: [
			{
				id: 'memory-1',
				category: 'preference',
				status: 'active',
				subject: 'Verbose memory subject',
				summary:
					'This memory summary is intentionally long and should not be rendered into broad search markdown.',
				details: 'Long memory details should stay out of the text response.',
				tags: ['search'],
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
		],
		suppressedCount: 0,
		retrievalQuery: 'search docs',
		retrieverResults: [],
		retrieverWarnings: [
			'First memory retriever warning should remain structured.',
			'Second memory retriever warning should remain structured.',
		],
	})
	const handler = await getSearchHandler()

	mockPerformanceNow.mockReturnValueOnce(100).mockReturnValueOnce(112)
	const successResponse = await handler({
		query: 'search docs',
		conversationId: 'conv-compact-search',
	})
	expect(successResponse.isError).toBeUndefined()
	expect(successResponse.structuredContent).toMatchObject({
		conversationId: 'conv-compact-search',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: expect.any(Number),
		},
	})
	expect(
		successResponse.structuredContent.timing.durationMs,
	).toBeGreaterThanOrEqual(0)

	const text = successResponse.content.map((item) => item.text).join('\n')
	expect(text.length).toBeGreaterThan(0)
	const result = successResponse.structuredContent.result as {
		warnings: Array<string>
		guidance?: string
		memories?: { surfaced: Array<{ id: string }> }
		matches: Array<{ type: string; entityRef?: string }>
	}
	expect(result.warnings).toHaveLength(2)
	expect(result.matches).toEqual([
		expect.objectContaining({
			type: 'capability',
			entityRef: 'search_docs:capability',
		}),
	])
	expect(result.memories?.surfaced).toEqual([
		expect.objectContaining({ id: 'memory-1' }),
	])

	mockPerformanceNow.mockReturnValueOnce(5).mockReturnValueOnce(9)
	const validationErrorResponse = await handler({
		conversationId: 'conv-search-error',
	})
	expect(validationErrorResponse.isError).toBe(true)
	expect(validationErrorResponse.structuredContent).toMatchObject({
		conversationId: 'conv-search-error',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: expect.any(Number),
		},
		error: expect.stringMatching(/query.*entity/i),
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
	expect(handledErrorResponse.structuredContent.error).toBe(
		'Registry unavailable',
	)
})
