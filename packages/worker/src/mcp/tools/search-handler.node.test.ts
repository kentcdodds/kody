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
	acknowledgeToolMemories: vi.fn(async () => undefined),
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
	searchCommunityListings: vi.fn(async () => []),
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
		acknowledgeToolMemories: (...args: Array<unknown>) =>
			mockModule.acknowledgeToolMemories(...args),
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

vi.mock('#worker/community/service.ts', () => ({
	searchCommunityListings: (...args: Array<unknown>) =>
		mockModule.searchCommunityListings(...args),
}))

const {
	registerSearchTool,
	SEARCH_MEMORY_ENRICHMENT_BUDGET_MS,
	memoryAcknowledgementWarning,
	memoryEnrichmentSkippedWarning,
} = await import('./search.ts')

const mockPerformanceNow = vi.spyOn(performance, 'now')

type SearchHandler = (input: {
	query?: string
	entity?: string | Array<string>
	domain?: string
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
			isPrivate: false,
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
			isPrivate: false,
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
	const { handler } = await getSearchRegistration({
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
			username: 'user',
		},
	})

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
		phaseTimings?: {
			memoryEnrichmentMs?: number
			memoryEnrichmentTimedOut?: boolean
		}
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
	expect(result.phaseTimings).toEqual(
		expect.objectContaining({
			memoryEnrichmentTimedOut: false,
			memoryEnrichmentMs: expect.any(Number),
			memoryAcknowledgementMs: expect.any(Number),
		}),
	)
	expect(mockModule.acknowledgeToolMemories).toHaveBeenCalledWith(
		expect.objectContaining({
			conversationId: 'conv-compact-search',
			memoryIds: ['memory-1'],
		}),
	)

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
	expect(batchText).toContain('openapi:widgets:getwidget:capability')

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

test('integration entity detail enriches related packages without bloating ranked search', async () => {
	const user = {
		userId: 'user-1',
		email: 'user@example.com',
		displayName: 'User',
		username: 'user',
	}
	const githubIntegrationValue = {
		name: '_integration:github',
		scope: 'user' as const,
		value: JSON.stringify({
			tokenUrl: 'https://github.com/login/oauth/access_token',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			clientIdValueName: 'github-client-id',
			clientSecretSecretName: 'github-client-secret',
			accessTokenSecretName: 'github-access-token',
			refreshTokenSecretName: null,
			requiredHosts: ['api.github.com', 'github.com'],
		}),
		description: 'GitHub OAuth integration',
		appId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		ttlMs: null,
	}

	vi.clearAllMocks()
	mockModule.listValues.mockResolvedValue([githubIntegrationValue])
	mockModule.listSavedPackagesByUserId.mockResolvedValue([])
	mockModule.searchCommunityListings.mockResolvedValue([
		{
			id: 'listing-github',
			ownerUserId: 'owner-1',
			packageId: 'pkg-github',
			sourceId: 'source-github',
			kodyId: 'github',
			name: '@kody/github',
			description: 'GitHub helpers',
			tags: ['github', 'api'],
			searchText: null,
			readmeContent: null,
			license: 'MIT',
			pinnedCommit: 'abc123',
			iconCommit: 'abc123',
			status: 'active',
			trustedCommit: 'abc123',
			trustedAt: '2026-01-01T00:00:00.000Z',
			trusted: true,
			featuredAt: null,
			featured: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			publishedAt: '2026-01-01T00:00:00.000Z',
			averageStars: null,
			ratingCount: 0,
			averageAdaptationEffort: null,
			forkCount: 0,
			starCount: 0,
		},
		{
			id: 'listing-cursor',
			ownerUserId: 'owner-1',
			packageId: 'pkg-cursor',
			sourceId: 'source-cursor',
			kodyId: 'cursor',
			name: '@kody/cursor',
			description: 'Cursor helpers that mention github.com in prose',
			tags: ['cursor'],
			searchText: null,
			readmeContent: null,
			license: 'MIT',
			pinnedCommit: 'abc123',
			iconCommit: 'abc123',
			status: 'active',
			trustedCommit: 'abc123',
			trustedAt: '2026-01-01T00:00:00.000Z',
			trusted: true,
			featuredAt: null,
			featured: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			publishedAt: '2026-01-01T00:00:00.000Z',
			averageStars: null,
			ratingCount: 0,
			averageAdaptationEffort: null,
			forkCount: 0,
			starCount: 0,
		},
	])

	const { handler } = await getSearchRegistration({ user })

	const ranked = await handler({
		query: 'github integration',
		conversationId: 'conv-integration-ranked',
	})
	expect(ranked.isError).toBeUndefined()
	expect(mockModule.searchCommunityListings).not.toHaveBeenCalled()
	const rankedResult = ranked.structuredContent.result as {
		matches: Array<{
			type: string
			relatedPackageSuggestions?: unknown
			entityRef?: string
		}>
	}
	const rankedIntegration = rankedResult.matches.find(
		(match) => match.type === 'integration',
	)
	expect(rankedIntegration).toMatchObject({
		type: 'integration',
		entityRef: 'github:integration',
	})
	expect(rankedIntegration).not.toHaveProperty('relatedPackageSuggestions')

	const detail = await handler({
		entity: 'github:integration',
		conversationId: 'conv-integration-detail',
	})
	expect(detail.isError).toBeUndefined()
	expect(mockModule.searchCommunityListings).toHaveBeenCalledTimes(1)
	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		query: 'github',
		limit: 12,
		trustedFirst: true,
		resultFilter: expect.any(Function),
	})
	expect(detail.structuredContent.result).toMatchObject({
		kind: 'entity',
		type: 'integration',
		id: 'github',
		relatedPackageSuggestions: [
			expect.objectContaining({
				source: 'community',
				kodyId: 'github',
				listingId: 'listing-github',
				trusted: true,
			}),
		],
	})
	const suggestions = (
		detail.structuredContent.result as {
			relatedPackageSuggestions: Array<{ kodyId: string }>
		}
	).relatedPackageSuggestions
	expect(suggestions.map((item) => item.kodyId)).toEqual(['github'])

	vi.clearAllMocks()
	mockModule.listValues.mockResolvedValue([githubIntegrationValue])
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{
			id: 'pkg-user-github',
			userId: 'user-1',
			name: '@user/github',
			kodyId: 'github',
			description: 'User github package',
			tags: ['github'],
			searchText: 'github helpers',
			sourceId: 'source-user-github',
			hasApp: false,
			hidden: false,
			isPrivate: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	])
	mockModule.searchCommunityListings.mockResolvedValue([
		{
			id: 'listing-github',
			ownerUserId: 'owner-1',
			packageId: 'pkg-github',
			sourceId: 'source-github',
			kodyId: 'github',
			name: '@kody/github',
			description: 'GitHub helpers',
			tags: ['github'],
			searchText: null,
			readmeContent: null,
			license: 'MIT',
			pinnedCommit: 'abc123',
			iconCommit: 'abc123',
			status: 'active',
			trustedCommit: 'abc123',
			trustedAt: '2026-01-01T00:00:00.000Z',
			trusted: true,
			featuredAt: null,
			featured: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			publishedAt: '2026-01-01T00:00:00.000Z',
			averageStars: null,
			ratingCount: 0,
			averageAdaptationEffort: null,
			forkCount: 0,
			starCount: 0,
		},
	])

	const { handler: userPackageHandler } = await getSearchRegistration({
		user,
	})
	const userPackageDetail = await userPackageHandler({
		entity: 'github:integration',
		conversationId: 'conv-integration-user-pkg',
	})
	expect(mockModule.searchCommunityListings).not.toHaveBeenCalled()
	expect(userPackageDetail.structuredContent.result).toMatchObject({
		type: 'integration',
		relatedPackageSuggestions: [
			expect.objectContaining({
				source: 'user',
				kodyId: 'github',
				entityRef: 'github:package',
			}),
		],
	})
})

test('search tool memory enrichment: timeout, rejection, and ack failure stay off the critical path', async () => {
	consoleWarn.mockImplementation(() => {})
	const user = {
		userId: 'user-1',
		email: 'user@example.com',
		displayName: 'User',
		username: 'user',
	}
	const memorySummary = {
		memories: [
			{
				id: 'memory-1',
				category: 'preference',
				status: 'active',
				subject: 'Search preference',
				summary: 'Prefers compact search results',
				details: '',
				tags: ['search'],
				updatedAt: '2026-04-20T00:00:00.000Z',
			},
		],
		suppressedCount: 0,
		retrievalQuery: 'search docs',
		retrieverResults: [],
		retrieverWarnings: [],
	}

	vi.clearAllMocks()
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})
	mockModule.loadRelevantMemoriesForTool.mockResolvedValueOnce(memorySummary)
	const { handler: structuredContextHandler } = await getSearchRegistration({
		user,
	})
	const structuredContextResult = await structuredContextHandler({
		query: ' ',
		conversationId: 'conv-structured-memory',
		memoryContext: { task: 'search docs' },
	})
	expect(mockModule.loadRelevantMemoriesForTool).toHaveBeenCalledWith(
		expect.objectContaining({
			memoryContext: { task: 'search docs' },
			acknowledgeSurfaced: false,
		}),
	)
	expect(
		(
			structuredContextResult.structuredContent.result as {
				memories?: { surfaced: Array<{ id: string }> }
			}
		).memories?.surfaced,
	).toEqual([expect.objectContaining({ id: 'memory-1' })])

	vi.clearAllMocks()
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})
	mockModule.loadRelevantMemoriesForTool.mockImplementation(
		() =>
			new Promise((resolve) => {
				setTimeout(
					() => resolve(memorySummary),
					SEARCH_MEMORY_ENRICHMENT_BUDGET_MS + 250,
				)
			}),
	)
	const { handler: timeoutHandler } = await getSearchRegistration({ user })
	const timedOut = await timeoutHandler({
		query: 'search docs',
		conversationId: 'conv-memory-budget',
	})
	const timedOutResult = timedOut.structuredContent.result as {
		matches: Array<{ type: string }>
		memories?: unknown
		warnings: Array<string>
		phaseTimings?: Record<string, unknown>
	}
	expect(timedOutResult.matches.length).toBeGreaterThan(0)
	expect(timedOutResult.memories).toBeUndefined()
	expect(timedOutResult.warnings).toContain(memoryEnrichmentSkippedWarning)
	expect(timedOutResult.phaseTimings).toEqual(
		expect.objectContaining({
			memoryEnrichmentTimedOut: true,
			memoryEnrichmentFailed: false,
			memoryEnrichmentMs: expect.any(Number),
			memoryEnrichmentWaitMs: expect.any(Number),
		}),
	)
	expect(mockModule.loadRelevantMemoriesForTool).toHaveBeenCalledWith(
		expect.objectContaining({ acknowledgeSurfaced: false }),
	)

	vi.clearAllMocks()
	consoleWarn.mockImplementation(() => {})
	const unhandled: Array<unknown> = []
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)
	try {
		mockModule.runPackageRetrievers.mockResolvedValue({
			results: [],
			warnings: [],
		})
		mockModule.loadRelevantMemoriesForTool.mockRejectedValueOnce(
			new Error('memory store unavailable'),
		)
		const { handler } = await getSearchRegistration({ user })
		const rejected = await handler({
			query: 'search docs',
			conversationId: 'conv-memory-reject',
		})
		const rejectedResult = rejected.structuredContent.result as {
			memories?: unknown
			warnings: Array<string>
			phaseTimings?: Record<string, unknown>
		}
		expect(rejectedResult.memories).toBeUndefined()
		expect(rejectedResult.warnings).toContain(memoryEnrichmentSkippedWarning)
		expect(rejectedResult.phaseTimings).toEqual(
			expect.objectContaining({
				memoryEnrichmentFailed: true,
				memoryEnrichmentTimedOut: false,
			}),
		)
		await Promise.resolve()
		await Promise.resolve()
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}

	vi.clearAllMocks()
	consoleWarn.mockImplementation(() => {})
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})
	mockModule.loadRelevantMemoriesForTool.mockResolvedValueOnce(memorySummary)
	mockModule.acknowledgeToolMemories.mockRejectedValueOnce(
		new Error('ack store unavailable'),
	)
	const { handler: ackHandler } = await getSearchRegistration({ user })
	const ackFailed = await ackHandler({
		query: 'search docs',
		conversationId: 'conv-memory-ack-fail',
	})
	const ackResult = ackFailed.structuredContent.result as {
		matches: Array<{ type: string }>
		memories?: { surfaced: Array<{ id: string }> }
		warnings: Array<string>
		phaseTimings?: Record<string, unknown>
	}
	expect(ackResult.matches.length).toBeGreaterThan(0)
	expect(ackResult.memories?.surfaced).toEqual([
		expect.objectContaining({ id: 'memory-1' }),
	])
	expect(ackResult.warnings).toContain(memoryAcknowledgementWarning)
	expect(ackResult.phaseTimings).toEqual(
		expect.objectContaining({
			memoryEnrichmentFailed: false,
			memoryAcknowledgementFailed: true,
			memoryAcknowledgementMs: expect.any(Number),
		}),
	)

	vi.clearAllMocks()
	consoleWarn.mockImplementation(() => {})
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})
	mockModule.loadRelevantMemoriesForTool.mockResolvedValueOnce(memorySummary)
	mockModule.acknowledgeToolMemories.mockImplementation(
		() => new Promise(() => {}),
	)
	const { handler: neverSettlingHandler } = await getSearchRegistration({
		user,
	})
	const neverSettling = await neverSettlingHandler({
		query: 'search docs',
		conversationId: 'conv-memory-ack-hang',
	})
	const hangResult = neverSettling.structuredContent.result as {
		memories?: { surfaced: Array<{ id: string }> }
		warnings: Array<string>
		phaseTimings?: Record<string, unknown>
	}
	expect(hangResult.memories?.surfaced).toEqual([
		expect.objectContaining({ id: 'memory-1' }),
	])
	expect(hangResult.warnings).toContain(memoryAcknowledgementWarning)
	expect(hangResult.phaseTimings).toEqual(
		expect.objectContaining({
			memoryAcknowledgementTimedOut: true,
			memoryEnrichmentFailed: false,
			memoryAcknowledgementMs: expect.any(Number),
		}),
	)
}, 10_000)

test('search tool domain param: browse, reject unknown, and scope ranked results', async () => {
	vi.clearAllMocks()
	consoleWarn.mockImplementation(() => {})
	const handler = await getSearchHandler()

	// Whitespace-only queries fall back to domain browsing (with its limit).
	const browseResponse = await handler({
		query: '   ',
		domain: 'meta',
		conversationId: 'conv-domain-browse',
	})
	expect(browseResponse.isError).toBeUndefined()
	const browseResult = browseResponse.structuredContent.result as {
		matches: Array<{ type: string; id?: string; domain?: string }>
	}
	expect(browseResult.matches).toEqual([
		expect.objectContaining({
			type: 'capability',
			id: 'search_docs',
			domain: 'meta',
		}),
	])
	expect(mockModule.runPackageRetrievers).not.toHaveBeenCalled()

	const unknownResponse = await handler({
		domain: 'nope',
		conversationId: 'conv-domain-unknown',
	})
	expect(unknownResponse.isError).toBe(true)
	expect(unknownResponse.structuredContent.error).toMatch(
		/Unknown domain "nope"/,
	)
	expect(unknownResponse.structuredContent.error).toContain('meta')

	mockModule.listSavedPackagesByUserId.mockResolvedValue(createSavedPackages())
	const { handler: scopedHandler } = await getSearchRegistration({
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
			username: 'user',
		},
	})
	const scopedResponse = await scopedHandler({
		query: 'search docs',
		domain: 'meta',
		conversationId: 'conv-domain-scoped',
	})
	expect(scopedResponse.isError).toBeUndefined()
	const scopedResult = scopedResponse.structuredContent.result as {
		matches: Array<{ type: string; domain?: string }>
	}
	expect(scopedResult.matches.length).toBeGreaterThan(0)
	for (const match of scopedResult.matches) {
		expect(match).toMatchObject({ type: 'capability', domain: 'meta' })
	}
	expect(mockModule.runPackageRetrievers).not.toHaveBeenCalled()
})
