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

test('loadRelevantMemoriesForTool returns context retriever results alongside memories', async () => {
	setupMemoryContextMocks()
	const result = await loadRelevantMemoriesForTool({
		env: { APP_DB: {}, AI: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
			storageContext: null,
			homeConnectorId: null,
			remoteConnectors: null,
			repoContext: null,
		},
		conversationId: 'conversation-1',
		memoryContext: {
			query: 'sprinkler instructions',
		},
	})

	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({
			baseUrl: 'https://heykody.dev',
			userId: 'user-1',
			scope: 'context',
			query: 'sprinkler instructions',
			maxProviders: 3,
		}),
	)
	expect(result?.memories).toEqual([])
	expect(result?.retrieverResults).toEqual([
		expect.objectContaining({
			id: 'note-1',
			kodyId: 'personal-inbox',
			retrieverKey: 'notes',
		}),
	])
	expect(result?.retrieverWarnings).toHaveLength(1)
})

test('loadRelevantMemoriesForTool keeps memories when context retrievers fail', async () => {
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

	const result = await loadRelevantMemoriesForTool({
		env: { APP_DB: {}, AI: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
			storageContext: null,
			homeConnectorId: null,
			remoteConnectors: null,
			repoContext: null,
		},
		conversationId: 'conversation-1',
		memoryContext: {
			query: 'sprinkler instructions',
		},
	})

	expect(result?.memories).toEqual([
		expect.objectContaining({
			id: 'memory-1',
			subject: 'Sprinkler setup',
		}),
	])
	expect(result?.retrieverResults).toEqual([])
	expect(result?.retrieverWarnings).toEqual([])
})

test('formatSurfacedMemoriesMarkdown omits empty memories heading for retriever-only context', () => {
	const [content] = formatSurfacedMemoriesMarkdown({
		memories: [],
		retrieverResults: [
			{
				id: 'note-1',
				title: 'Sprinkler controller',
				summary: 'Hold next and back for setup mode.',
				packageId: 'package-1',
				kodyId: 'personal-inbox',
				retrieverKey: 'notes',
				retrieverName: 'Personal notes',
			},
		],
		retrieverWarnings: [],
		suppressedCount: 0,
		retrievalQuery: 'sprinkler instructions',
	})

	expect(content?.type).toBe('text')
	const lines = content?.text?.split('\n') ?? []
	expect(lines[0]).toBe('## Relevant retriever results')
	expect(lines[1]).toBe('')
	expect(lines[2]).toContain('**Sprinkler controller**')
	expect(lines[2]).toContain('Hold next and back for setup mode')
	expect(lines[2]).toContain('(`personal-inbox/notes`)')
})
