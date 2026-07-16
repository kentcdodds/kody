import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

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
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	listSavedPackagesByUserId: vi.fn(async () => []),
	listUserSecretsForSearch: vi.fn(async () => []),
	listValues: vi.fn(async () => []),
	loadPackageSourceBySourceId: vi.fn(),
	loadRelevantMemoriesForTool: vi.fn(async () => null),
	runPackageRetrievers: vi.fn(async () => ({
		results: [],
		warnings: [],
	})),
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
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
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

vi.mock('#worker/package-retrievers/service.ts', () => ({
	runPackageRetrievers: (...args: Array<unknown>) =>
		mockModule.runPackageRetrievers(...args),
}))

vi.mock('#worker/remote-connector/status.ts', () => ({
	getRemoteConnectorStatus: (...args: Array<unknown>) =>
		mockModule.getRemoteConnectorStatus(...args),
}))

const { registerSearchTool } = await import('./search.ts')

const mockPerformanceNow = vi.spyOn(performance, 'now')

type SearchHandler = (input: {
	query?: string
	entity?: string | Array<string>
	limit?: number
	maxResponseSize?: number
	conversationId?: string
	includeHiddenPackages?: boolean
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

async function getSearchRegistration(input?: {
	user?: {
		userId: string
		email: string
		displayName: string
		username?: string
	} | null
}) {
	const registerTool = vi.fn()

	await registerSearchTool({
		server: {
			registerTool,
		} as never,
		getEnv: vi.fn(() => ({ APP_DB: {} })),
		getCallerContext: vi.fn(() => ({
			baseUrl: 'https://example.com',
			user: input?.user === undefined ? null : input.user,
			remoteConnectors: [{ instanceId: 'home' }],
		})),
	} as never)

	expect(registerTool).toHaveBeenCalledTimes(1)
	const [name, , handler] = registerTool.mock.calls[0] ?? []
	expect(name).toBe('search')
	return { handler: handler as SearchHandler }
}

async function getSearchHandler() {
	const { handler } = await getSearchRegistration()
	return handler
}

function createSavedPackages() {
	return [
		{
			id: 'pkg-hidden',
			userId: 'user-1',
			name: 'hidden-notes-pkg',
			kodyId: 'hidden-notes-pkg',
			description: 'hidden notes package',
			tags: [],
			searchText: 'hidden notes package',
			sourceId: 'source-hidden',
			hasApp: false,
			hidden: true,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		{
			id: 'pkg-visible',
			userId: 'user-1',
			name: 'visible-notes-pkg',
			kodyId: 'visible-notes-pkg',
			description: 'visible notes package',
			tags: [],
			searchText: 'visible notes package',
			sourceId: 'source-visible',
			hasApp: false,
			hidden: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	]
}

const exactPackageId = '550e8400-e29b-41d4-a716-446655440000'

function createExactPackage(hidden: boolean) {
	return {
		id: exactPackageId,
		userId: 'user-1',
		name: '@user/exact-notes',
		kodyId: 'exact-notes',
		description: 'Exact notes package',
		tags: ['notes'],
		searchText: 'exact notes package',
		sourceId: 'source-exact',
		hasApp: false,
		hidden,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
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

test('search tool excludes hidden packages by default and includes them with includeHiddenPackages', async () => {
	vi.clearAllMocks()
	consoleWarn.mockImplementation(() => {})
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})
	mockModule.listSavedPackagesByUserId.mockResolvedValue(createSavedPackages())

	const { handler } = await getSearchRegistration({
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
			username: 'user',
		},
	})

	mockPerformanceNow.mockReturnValueOnce(100).mockReturnValueOnce(110)
	const defaultResponse = await handler({
		query: 'notes package',
		conversationId: 'conv-hidden-default',
	})
	expect(defaultResponse.isError).toBeUndefined()
	const defaultResult = defaultResponse.structuredContent.result as {
		matches: Array<{ type: string; kodyId?: string }>
	}
	const defaultPackageIds = defaultResult.matches
		.filter((match) => match.type === 'package')
		.map((match) => match.kodyId)
	expect(defaultPackageIds).toContain('visible-notes-pkg')
	expect(defaultPackageIds).not.toContain('hidden-notes-pkg')
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({
			scope: 'search',
			includeHiddenPackages: false,
		}),
	)

	mockModule.listSavedPackagesByUserId.mockResolvedValue(createSavedPackages())
	mockPerformanceNow.mockReturnValueOnce(200).mockReturnValueOnce(210)
	const includeResponse = await handler({
		query: 'notes package',
		conversationId: 'conv-hidden-include',
		includeHiddenPackages: true,
	})
	expect(includeResponse.isError).toBeUndefined()
	const includeResult = includeResponse.structuredContent.result as {
		matches: Array<{ type: string; kodyId?: string }>
	}
	const includePackageIds = includeResult.matches
		.filter((match) => match.type === 'package')
		.map((match) => match.kodyId)
		.sort()
	expect(includePackageIds).toEqual(['hidden-notes-pkg', 'visible-notes-pkg'])
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({
			scope: 'search',
			includeHiddenPackages: true,
		}),
	)
})

test('search tool treats exact package identity as authoritative and still resolves hidden entity lookups', async () => {
	vi.clearAllMocks()
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createExactPackage(true))
		.mockResolvedValueOnce(createExactPackage(true))
		.mockResolvedValueOnce(createExactPackage(true))
	mockModule.loadPackageSourceBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@user/exact-notes',
			exports: { '.': './index.ts' },
			kody: {
				id: 'exact-notes',
				description: 'Exact notes package',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@user/exact-notes',
				exports: { '.': './index.ts' },
				kody: {
					id: 'exact-notes',
					description: 'Exact notes package',
				},
			}),
			'index.ts': 'export default function main() {}',
		},
	})
	const { handler } = await getSearchRegistration({
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
			username: 'user',
		},
	})

	mockPerformanceNow.mockReturnValueOnce(100).mockReturnValueOnce(110)
	const hiddenResponse = await handler({
		query: exactPackageId,
		conversationId: 'conv-exact-hidden',
	})
	expect(hiddenResponse.isError).toBeUndefined()
	expect(
		hiddenResponse.structuredContent.result as { matches: Array<unknown> },
	).toMatchObject({ matches: [] })

	mockPerformanceNow.mockReturnValueOnce(200).mockReturnValueOnce(210)
	const includedResponse = await handler({
		query: `https://example.com/account/packages/${exactPackageId}`,
		conversationId: 'conv-exact-included',
		includeHiddenPackages: true,
	})
	expect(includedResponse.isError).toBeUndefined()
	expect(
		(
			includedResponse.structuredContent.result as {
				matches: Array<Record<string, unknown>>
			}
		).matches,
	).toEqual([
		expect.objectContaining({
			type: 'package',
			packageId: exactPackageId,
			kodyId: 'exact-notes',
			hidden: true,
		}),
	])
	expect(mockModule.runPackageRetrievers).not.toHaveBeenCalled()
	expect(mockModule.getCapabilityRegistryForContext).not.toHaveBeenCalled()

	mockPerformanceNow.mockReturnValueOnce(300).mockReturnValueOnce(310)
	const entityResponse = await handler({
		entity: `${exactPackageId}:package`,
		conversationId: 'conv-uuid-entity',
	})
	expect(entityResponse.isError).toBeUndefined()
	expect(entityResponse.structuredContent.result).toMatchObject({
		kind: 'entity',
		type: 'package',
		packageId: exactPackageId,
		kodyId: 'exact-notes',
		hidden: true,
	})
	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			packageId: exactPackageId,
		},
	)
	expect(mockModule.getSavedPackageByKodyId).not.toHaveBeenCalled()
})

test('search tool batches entity detail with per-ref isolation and preserves single-entity shape', async () => {
	vi.clearAllMocks()
	mockModule.getCapabilityRegistryForContext.mockResolvedValue({
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
				source: 'builtin',
				inputSchema: { type: 'object', properties: {} },
				inputTypeDefinition: 'type SearchDocsInput = Record<string, never>',
			},
			'openapi:widgets:createwidget': {
				name: 'openapi:widgets:createwidget',
				description: 'Create a widget.',
				domain: 'openapi:widgets',
				keywords: [],
				inputFields: ['name'],
				requiredInputFields: ['name'],
				outputFields: [],
				readOnly: false,
				idempotent: false,
				destructive: false,
				source: 'openapi',
				openApi: {
					bindingName: 'widgets',
					kodyName: 'widgets',
					operationSlug: 'createwidget',
					method: 'post',
					path: '/widgets',
				},
				inputSchema: {
					type: 'object',
					properties: { name: { type: 'string' } },
					required: ['name'],
				},
				inputTypeDefinition: 'type CreateWidgetInput = { name: string }',
			},
			'openapi:widgets:getwidget': {
				name: 'openapi:widgets:getwidget',
				description: 'Get a widget.',
				domain: 'openapi:widgets',
				keywords: [],
				inputFields: ['id'],
				requiredInputFields: ['id'],
				outputFields: [],
				readOnly: true,
				idempotent: true,
				destructive: false,
				source: 'openapi',
				openApi: {
					bindingName: 'widgets',
					kodyName: 'widgets',
					operationSlug: 'getwidget',
					method: 'get',
					path: '/widgets/{id}',
				},
				inputSchema: {
					type: 'object',
					properties: { id: { type: 'string' } },
					required: ['id'],
				},
				inputTypeDefinition: 'type GetWidgetInput = { id: string }',
			},
		},
	})

	const handler = await getSearchHandler()

	mockPerformanceNow.mockReturnValueOnce(100).mockReturnValueOnce(110)
	const singleResponse = await handler({
		entity: 'search_docs:capability',
		conversationId: 'conv-single-entity',
	})
	expect(singleResponse.isError).toBeUndefined()
	expect(singleResponse.structuredContent.result).toMatchObject({
		kind: 'entity',
		type: 'capability',
		id: 'search_docs',
		entityRef: 'search_docs:capability',
	})
	expect(singleResponse.structuredContent.result).not.toHaveProperty(
		'relatedOperations',
	)
	expect(Array.isArray(singleResponse.structuredContent.result)).toBe(false)

	mockPerformanceNow.mockReturnValueOnce(200).mockReturnValueOnce(210)
	const batchSuccess = await handler({
		entity: [
			'openapi:widgets:createwidget:capability',
			'openapi:widgets:getwidget:capability',
		],
		conversationId: 'conv-batch-success',
	})
	expect(batchSuccess.isError).toBeUndefined()
	expect(batchSuccess.structuredContent.result).toEqual([
		expect.objectContaining({
			kind: 'entity',
			type: 'capability',
			id: 'openapi:widgets:createwidget',
			relatedOperations: [
				expect.objectContaining({
					name: 'openapi:widgets:getwidget',
					method: 'get',
					path: '/widgets/{id}',
				}),
			],
		}),
		expect.objectContaining({
			kind: 'entity',
			type: 'capability',
			id: 'openapi:widgets:getwidget',
			relatedOperations: [
				expect.objectContaining({
					name: 'openapi:widgets:createwidget',
				}),
			],
		}),
	])
	const batchText = batchSuccess.content.map((item) => item.text).join('\n')
	expect(batchText).toContain('---')
	expect(batchText).toContain('## Related operations (same provider)')

	mockPerformanceNow.mockReturnValueOnce(300).mockReturnValueOnce(310)
	const partialFailure = await handler({
		entity: [
			'openapi:widgets:createwidget:capability',
			'missing_thing:capability',
		],
		conversationId: 'conv-batch-partial',
	})
	expect(partialFailure.isError).toBeUndefined()
	expect(partialFailure.structuredContent.result).toEqual([
		expect.objectContaining({
			kind: 'entity',
			type: 'capability',
			id: 'openapi:widgets:createwidget',
		}),
		expect.objectContaining({
			entityRef: 'missing_thing:capability',
			error: expect.stringMatching(/not found/i),
		}),
	])

	mockPerformanceNow.mockReturnValueOnce(400).mockReturnValueOnce(410)
	const allFailed = await handler({
		entity: ['missing_a:capability', 'missing_b:capability'],
		conversationId: 'conv-batch-all-failed',
	})
	expect(allFailed.isError).toBe(true)
	expect(allFailed.structuredContent.error).toMatch(
		/all entity lookups failed/i,
	)
	expect(allFailed.structuredContent.result).toEqual([
		expect.objectContaining({
			entityRef: 'missing_a:capability',
			error: expect.any(String),
		}),
		expect.objectContaining({
			entityRef: 'missing_b:capability',
			error: expect.any(String),
		}),
	])
})
