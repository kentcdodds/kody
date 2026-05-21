import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	surfaceRelevantMemories: vi.fn(),
	runPackageRetrievers: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	surfaceRelevantMemories: (...args: Array<unknown>) =>
		mockModule.surfaceRelevantMemories(...args),
}))

vi.mock('#worker/package-retrievers/service.ts', () => ({
	runPackageRetrievers: (...args: Array<unknown>) =>
		mockModule.runPackageRetrievers(...args),
}))

const { loadRelevantMemoriesForTool } = await import('./memory-tool-context.ts')
const { formatSurfacedMemoriesMarkdown } =
	await import('./memory-tool-context.ts')

function setupMemoryContextMocks() {
	mockModule.surfaceRelevantMemories.mockReset()
	mockModule.runPackageRetrievers.mockReset()
	mockModule.surfaceRelevantMemories.mockResolvedValue({
		memories: [],
		suppressedCount: 0,
		retrievalQuery: 'sprinkler instructions',
	})
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
		warnings: [
			'Package retriever "personal-inbox/notes" failed and was skipped.',
		],
	})
}

test('memory tool context surfaces retriever results, keeps memories on retriever failure, and formats retriever-only markdown', async () => {
	setupMemoryContextMocks()
	const callerContext = {
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'User',
		},
		storageContext: null,
		remoteConnectors: null,
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
	expect(withRetrievers?.retrieverWarnings).toHaveLength(1)

	const [retrieverOnlyContent] = formatSurfacedMemoriesMarkdown({
		memories: [],
		retrieverResults: withRetrievers?.retrieverResults ?? [],
		retrieverWarnings: [],
		suppressedCount: 0,
		retrievalQuery: 'sprinkler instructions',
	})
	expect(retrieverOnlyContent?.type).toBe('text')
	expect(retrieverOnlyContent?.text).not.toContain('## Relevant memories')
	expect(retrieverOnlyContent?.text).toContain('## Relevant retriever results')
	expect(retrieverOnlyContent?.text).not.toContain('## Retriever warnings')

	setupMemoryContextMocks()
	mockModule.surfaceRelevantMemories.mockResolvedValue({
		memories: [
			{
				id: 'memory-1',
				category: 'workflow',
				status: 'active',
				subject: 'Sprinkler setup',
				summary: 'Sprinkler instructions are stored in notes.',
				details: '',
				tags: ['sprinkler'],
				sourceUris: [],
				updatedAt: '2026-04-28T00:00:00.000Z',
			},
		],
		suppressedCount: 0,
		retrievalQuery: 'sprinkler instructions',
	})
	mockModule.runPackageRetrievers.mockRejectedValue(
		new Error('retriever unavailable'),
	)

	const withoutRetrievers = await loadRelevantMemoriesForTool(request)
	expect(withoutRetrievers?.memories).toEqual([
		expect.objectContaining({
			id: 'memory-1',
			subject: 'Sprinkler setup',
		}),
	])
	expect(withoutRetrievers?.retrieverResults).toEqual([])
	expect(withoutRetrievers?.retrieverWarnings).toEqual([])
})
