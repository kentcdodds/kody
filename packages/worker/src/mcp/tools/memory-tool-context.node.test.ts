import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	searchMemoryRecords: vi.fn(),
	acknowledgeSurfacedMemories: vi.fn(),
	runPackageRetrievers: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	searchMemoryRecords: (...args: Array<unknown>) =>
		mockModule.searchMemoryRecords(...args),
	acknowledgeSurfacedMemories: (...args: Array<unknown>) =>
		mockModule.acknowledgeSurfacedMemories(...args),
}))

vi.mock('#worker/package-retrievers/service.ts', () => ({
	runPackageRetrievers: (...args: Array<unknown>) =>
		mockModule.runPackageRetrievers(...args),
}))

const { loadRelevantMemoriesForTool } = await import('./memory-tool-context.ts')
const { formatSurfacedMemoriesMarkdown } =
	await import('./memory-tool-context.ts')

function setupMemoryContextMocks() {
	mockModule.searchMemoryRecords.mockReset()
	mockModule.acknowledgeSurfacedMemories.mockReset()
	mockModule.runPackageRetrievers.mockReset()
	mockModule.searchMemoryRecords.mockResolvedValue({
		matches: [],
		suppressedCount: 0,
		query: 'sprinkler instructions',
	})
	mockModule.acknowledgeSurfacedMemories.mockResolvedValue(undefined)
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [
			{
				id: 'note-1',
				title: '## Sprinkler controller',
				summary: '```ignore\nHold next and back for setup mode.\n```',
				packageId: 'package-1',
				kodyId: 'personal-inbox',
				retrieverKey: 'notes',
				retrieverName: 'Personal notes',
			},
		],
		warnings: [],
	})
}

test('memory tool context surfaces retriever results, fails on retriever errors, and formats retriever-only markdown', async () => {
	setupMemoryContextMocks()
	const callerContext = {
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
		},
		storageContext: null,
		repoContext: null,
	}
	const request = {
		env: { APP_DB: {}, AI: {} } as Env,
		callerContext,
		conversationId: 'conversation-1',
		memoryContext: {
			query: 'sprinkler instructions',
		},
	}

	const withRetrievers = await loadRelevantMemoriesForTool(request)
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			scope: 'context',
			query: 'sprinkler instructions',
			maxProviders: 3,
		}),
	)
	expect(withRetrievers?.memories).toEqual([])
	expect(withRetrievers?.retrieverResults).toEqual([
		expect.objectContaining({
			id: 'note-1',
			kodyId: 'personal-inbox',
			retrieverKey: 'notes',
		}),
	])
	expect(withRetrievers?.retrieverWarnings).toEqual([])

	const [retrieverOnlyContent] = formatSurfacedMemoriesMarkdown({
		memories: [],
		retrieverResults: withRetrievers?.retrieverResults ?? [],
		retrieverWarnings: [],
		suppressedCount: 0,
		retrievalQuery: 'sprinkler instructions',
	})
	expect(retrieverOnlyContent?.type).toBe('text')
	expect(retrieverOnlyContent?.text?.length).toBeGreaterThan(0)

	setupMemoryContextMocks()
	mockModule.searchMemoryRecords.mockResolvedValue({
		matches: [
			{
				id: 'memory-1',
				category: 'workflow',
				status: 'active',
				subject: 'Sprinkler setup',
				summary: 'Sprinkler instructions are stored in notes.',
				details: '',
				tags: ['sprinkler'],
				sourceUris: [],
				dedupeKey: null,
				createdAt: '2026-04-28T00:00:00.000Z',
				updatedAt: '2026-04-28T00:00:00.000Z',
				lastAccessedAt: null,
				deletedAt: null,
				score: 0.03,
			},
		],
		suppressedCount: 0,
		query: 'sprinkler instructions',
	})
	mockModule.runPackageRetrievers.mockRejectedValue(
		new Error('retriever unavailable'),
	)

	await expect(loadRelevantMemoriesForTool(request)).rejects.toThrow(
		'retriever unavailable',
	)
})

test('automatic memory context drops archived and low-score matches', async () => {
	setupMemoryContextMocks()
	const baseMemory = {
		category: 'workflow',
		subject: 'Search workflow',
		summary: 'Use ranked search.',
		details: '',
		tags: ['search'],
		sourceUris: [],
		dedupeKey: null,
		createdAt: '2026-04-28T00:00:00.000Z',
		updatedAt: '2026-04-28T00:00:00.000Z',
		lastAccessedAt: null,
		deletedAt: null,
	}
	mockModule.searchMemoryRecords.mockResolvedValue({
		matches: [
			{
				...baseMemory,
				id: 'active-strong',
				status: 'active',
				score: 0.03,
			},
			{
				...baseMemory,
				id: 'active-noise',
				status: 'active',
				score: 0.0164,
			},
			{
				...baseMemory,
				id: 'archived-strong',
				status: 'archived',
				score: 0.04,
			},
		],
		suppressedCount: 0,
		query: 'ranked search',
	})
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})

	const result = await loadRelevantMemoriesForTool({
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
			storageContext: null,
			repoContext: null,
		},
		conversationId: 'conversation-quality',
		memoryContext: { query: 'ranked search' },
		acknowledgeSurfaced: false,
	})

	expect(result?.memories.map((memory) => memory.id)).toEqual(['active-strong'])
	expect(mockModule.acknowledgeSurfacedMemories).not.toHaveBeenCalled()
})
