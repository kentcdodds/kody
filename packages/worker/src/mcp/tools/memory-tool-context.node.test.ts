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

const {
	automaticMemorySingleListRankOneScore,
	formatSurfacedMemoriesMarkdown,
	loadRelevantMemoriesForTool,
} = await import('./memory-tool-context.ts')

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

test('memory tool context surfaces retrievers, filters weak matches, fails on retriever errors, and formats markdown', async () => {
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
				id: 'active-rank-one',
				status: 'active',
				score: automaticMemorySingleListRankOneScore,
			},
			{
				...baseMemory,
				id: 'active-rank-two',
				status: 'active',
				score: 1 / 62,
			},
			{
				...baseMemory,
				id: 'active-rank-three',
				status: 'active',
				score: 1 / 63,
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

	const filtered = await loadRelevantMemoriesForTool({
		env: { APP_DB: {} } as Env,
		callerContext,
		conversationId: 'conversation-quality',
		memoryContext: { query: 'ranked search' },
		acknowledgeSurfaced: false,
	})
	expect(filtered?.memories).toEqual([
		{
			id: 'active-rank-one',
			subject: 'Search workflow',
			summary: 'Use ranked search.',
		},
		{
			id: 'active-rank-two',
			subject: 'Search workflow',
			summary: 'Use ranked search.',
		},
	])
	expect(mockModule.acknowledgeSurfacedMemories).not.toHaveBeenCalled()

	const [compactContent] = formatSurfacedMemoriesMarkdown(filtered)
	expect(compactContent?.text).toBe(
		[
			'## Relevant memories',
			'',
			'- **Search workflow** — Use ranked search.',
			'- **Search workflow** — Use ranked search.',
		].join('\n'),
	)
	expect(compactContent?.text).not.toContain('Category')
	expect(compactContent?.text).not.toContain('Tags')
	expect(compactContent?.text).not.toContain('Updated')
	expect(compactContent?.text).not.toContain('active-rank-one')

	setupMemoryContextMocks()
	mockModule.searchMemoryRecords.mockResolvedValue({
		matches: [
			{
				...baseMemory,
				id: 'dup-first',
				status: 'active',
				dedupeKey: 'openai-apps-domain-challenge',
				subject: 'OpenAI Apps domain verification',
				summary: 'Challenge token is a static public asset.',
				score: automaticMemorySingleListRankOneScore,
			},
			{
				...baseMemory,
				id: 'dup-second',
				status: 'active',
				dedupeKey: '  openai-apps-domain-challenge  ',
				subject: 'OpenAI Apps domain verification',
				summary: 'Challenge token is a static public asset.',
				score: 1 / 62,
			},
			{
				...baseMemory,
				id: 'next-distinct',
				status: 'active',
				dedupeKey: 'prefilled-setup-urls',
				subject: 'Always prefill hosted setup URLs',
				summary: 'Give a prefilled secrets URL.',
				score: 1 / 63,
			},
			{
				...baseMemory,
				id: 'null-key-one',
				status: 'active',
				dedupeKey: null,
				subject: 'Null key one',
				summary: 'No shared key.',
				score: 1 / 64,
			},
		],
		suppressedCount: 0,
		query: 'openai apps challenge',
	})
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})
	const collapsed = await loadRelevantMemoriesForTool({
		env: { APP_DB: {} } as Env,
		callerContext,
		conversationId: 'conversation-dedupe',
		memoryContext: { query: 'openai apps challenge' },
	})
	expect(collapsed?.memories).toEqual([
		{
			id: 'dup-first',
			subject: 'OpenAI Apps domain verification',
			summary: 'Challenge token is a static public asset.',
		},
		{
			id: 'next-distinct',
			subject: 'Always prefill hosted setup URLs',
			summary: 'Give a prefilled secrets URL.',
		},
	])

	setupMemoryContextMocks()
	mockModule.searchMemoryRecords.mockResolvedValue({
		matches: [
			{
				...baseMemory,
				id: 'null-a',
				status: 'active',
				dedupeKey: null,
				subject: 'Untitled habit A',
				summary: 'First untitled fact.',
				score: automaticMemorySingleListRankOneScore,
			},
			{
				...baseMemory,
				id: 'null-b',
				status: 'active',
				dedupeKey: '   ',
				subject: 'Untitled habit B',
				summary: 'Second untitled fact.',
				score: 1 / 62,
			},
		],
		suppressedCount: 0,
		query: 'untitled habits',
	})
	mockModule.runPackageRetrievers.mockResolvedValue({
		results: [],
		warnings: [],
	})
	const untitled = await loadRelevantMemoriesForTool({
		env: { APP_DB: {} } as Env,
		callerContext,
		conversationId: 'conversation-null-keys',
		memoryContext: { query: 'untitled habits' },
	})
	expect(untitled?.memories.map((memory) => memory.id)).toEqual([
		'null-a',
		'null-b',
	])
})
