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
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	listSavedPackagesByUserId: vi.fn(async () => []),
	listUserSecretsForSearch: vi.fn(async () => []),
	listValues: vi.fn(async () => []),
	loadRelevantMemoriesForTool: vi.fn(async () => null),
	acknowledgeToolMemories: vi.fn(async () => undefined),
	buildMemoryRetrievalQuery: vi.fn(
		(
			input?: {
				task?: string
				query?: string
				entities?: Array<string>
				constraints?: Array<string>
			} | null,
		) =>
			[
				input?.task,
				input?.query,
				...(input?.entities ?? []),
				...(input?.constraints ?? []),
			]
				.filter(Boolean)
				.join('\n'),
	),
	runPackageRetrievers: vi.fn(async () => ({ results: [], warnings: [] })),
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

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: (...args: Array<unknown>) =>
		mockModule.listUserSecretsForSearch(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	listValues: (...args: Array<unknown>) => mockModule.listValues(...args),
}))

vi.mock('#mcp/tools/memory-tool-context.ts', () => ({
	loadRelevantMemoriesForTool: (...args: Array<unknown>) =>
		mockModule.loadRelevantMemoriesForTool(...args),
	acknowledgeToolMemories: (...args: Array<unknown>) =>
		mockModule.acknowledgeToolMemories(...args),
	buildMemoryRetrievalQuery: (...args: Array<unknown>) =>
		mockModule.buildMemoryRetrievalQuery(...args),
}))

vi.mock('#worker/package-retrievers/service.ts', () => ({
	runPackageRetrievers: (...args: Array<unknown>) =>
		mockModule.runPackageRetrievers(...args),
}))

const { searchCapability } = await import('./search.ts')

const packageId = '550e8400-e29b-41d4-a716-446655440000'

function createContext(user: { userId: string; username: string } | null) {
	return {
		env: {
			APP_DB: {},
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as unknown as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: user
				? {
						...user,
						email: 'user@example.com',
						displayName: 'User',
					}
				: null,
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

function createSavedPackage(hidden = false) {
	return {
		id: packageId,
		userId: 'user-1',
		name: '@user/daily-notes',
		kodyId: 'daily-notes',
		description: 'Daily notes package',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
	}
}

test('meta search wires exact package identity, hidden gating, and natural-language discovery', async () => {
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(createSavedPackage(true))
		.mockResolvedValueOnce(createSavedPackage(true))
	mockModule.getSavedPackageByKodyId.mockResolvedValueOnce(createSavedPackage())
	const context = createContext({ userId: 'user-1', username: 'user' })

	const byAccountUrl = await searchCapability.handler(
		{
			query: `https://heykody.dev/account/packages/${packageId}`,
			conversationId: 'meta-account-url',
		},
		context,
	)
	expect(byAccountUrl.matches).toEqual([
		expect.objectContaining({
			type: 'package',
			packageId,
			kodyId: 'daily-notes',
			hidden: false,
		}),
	])

	const byHostedUrl = await searchCapability.handler(
		{
			query: '/@user/packages/daily-notes',
			conversationId: 'meta-hosted-url',
		},
		context,
	)
	expect(byHostedUrl.matches).toEqual([
		expect.objectContaining({
			type: 'package',
			packageId,
			kodyId: 'daily-notes',
		}),
	])

	const hidden = await searchCapability.handler(
		{ query: packageId, conversationId: 'meta-hidden' },
		context,
	)
	expect(hidden.matches).toEqual([])
	const included = await searchCapability.handler(
		{
			query: packageId,
			includeHiddenPackages: true,
			conversationId: 'meta-hidden-included',
		},
		context,
	)
	expect(included.matches).toEqual([
		expect.objectContaining({
			type: 'package',
			packageId,
			hidden: true,
		}),
	])

	const naturalLanguage = await searchCapability.handler(
		{ query: 'search docs', conversationId: 'meta-natural-language' },
		context,
	)
	expect(naturalLanguage.matches).toEqual([
		expect.objectContaining({
			type: 'capability',
			entityRef: 'search_docs:capability',
		}),
	])

	const unauthenticated = await searchCapability.handler(
		{ query: packageId, conversationId: 'meta-unauthenticated' },
		createContext(null),
	)
	expect(unauthenticated.matches).toEqual([])

	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			packageId,
		},
	)
	expect(mockModule.getSavedPackageByKodyId).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			kodyId: 'daily-notes',
		},
	)
	expect(mockModule.getCapabilityRegistryForContext).toHaveBeenCalledTimes(1)
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledTimes(1)
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({
			conversationId: 'meta-natural-language',
			query: 'search docs',
		}),
	)
})

test('meta search supports domain-only browsing and requires query or domain', async () => {
	const context = createContext({ userId: 'user-1', username: 'user' })

	const browse = await searchCapability.handler(
		{ domain: 'meta', conversationId: 'meta-domain-browse' },
		context,
	)
	expect(browse.matches).toEqual([
		expect.objectContaining({
			type: 'capability',
			entityRef: 'search_docs:capability',
			domain: 'meta',
		}),
	])

	await expect(
		searchCapability.handler({ conversationId: 'meta-missing-args' }, context),
	).rejects.toThrow('Provide "query" or "domain".')
})
