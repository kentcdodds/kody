import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	searchMemoryRecords: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	memorySearchMutationGuidance: 'Use this exact id for memory mutations.',
	searchMemoryRecords: (...args: Array<unknown>) =>
		mockModule.searchMemoryRecords(...args),
}))

const { metaMemorySearchCapability } = await import('./meta-memory-search.ts')

test('meta_memory_search annotates returned ids as mutable for the signed-in user', async () => {
	mockModule.searchMemoryRecords.mockResolvedValueOnce({
		query: 'theme preference',
		matches: [
			{
				id: 'memory-1',
				category: 'preference',
				status: 'active',
				subject: 'Preferred editor theme',
				summary: 'User prefers a dark editor theme.',
				details: '',
				tags: ['theme'],
				sourceUris: ['https://docs.example.com/preferences/editor-theme'],
				dedupeKey: 'pref:editor-theme',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-02T00:00:00.000Z',
				lastAccessedAt: null,
				deletedAt: null,
				score: 0.98,
			},
		],
		suppressedCount: 0,
	})

	const result = await metaMemorySearchCapability.handler(
		{
			query: 'theme preference',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)

	expect(mockModule.searchMemoryRecords).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-123',
			query: 'theme preference',
		}),
	)
	expect(result.matches[0]).toMatchObject({
		id: 'memory-1',
		can_mutate: true,
		mutation_guidance: 'Use this exact id for memory mutations.',
	})
})
