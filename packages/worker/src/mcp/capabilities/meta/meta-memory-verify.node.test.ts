import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	verifyMemoryCandidate: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	verifyMemoryCandidate: (...args: Array<unknown>) =>
		mockModule.verifyMemoryCandidate(...args),
}))

const { metaMemoryVerifyCapability } = await import('./meta-memory-verify.ts')

test('meta_memory_verify trims verbose related memory fields from the response', async () => {
	const env = {} as Env
	mockModule.verifyMemoryCandidate.mockResolvedValueOnce({
		candidate: {
			subject: 'Preferred package manager',
			summary: 'Use npm commands in this repository.',
			details: 'Always prefer npm scripts when working in this repo.',
			category: 'preference',
			tags: ['package-manager'],
			dedupe_key: 'repo:package-manager',
		},
		relatedMemories: [
			{
				memory: {
					id: 'mem-123',
					category: 'preference',
					status: 'active',
					subject: 'Package manager preference',
					summary: 'Repository workflows use npm.',
					details:
						'Long details that should stay available via meta_memory_get only.',
					tags: ['package-manager', 'workflow'],
					dedupeKey: 'repo:package-manager',
					createdAt: '2026-04-11T00:00:00.000Z',
					updatedAt: '2026-04-11T00:00:00.000Z',
					lastAccessedAt: '2026-04-11T00:00:00.000Z',
					deletedAt: null,
				},
				score: 0.91,
			},
		],
		suppressedCount: 0,
	})

	const result = await metaMemoryVerifyCapability.handler(
		{
			subject: 'Preferred package manager',
			summary: 'Use npm commands in this repository.',
			details: 'Always prefer npm scripts when working in this repo.',
			category: 'preference',
			tags: ['package-manager'],
			dedupe_key: 'repo:package-manager',
			limit: 3,
			conversation_id: 'conv-123',
			include_suppressed_in_conversation: true,
		},
		{
			env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-123',
					email: 'user@example.com',
					displayName: 'Test User',
				},
			}),
		},
	)

	expect(mockModule.verifyMemoryCandidate).toHaveBeenCalledWith({
		env,
		userId: 'user-123',
		candidate: {
			category: 'preference',
			subject: 'Preferred package manager',
			summary: 'Use npm commands in this repository.',
			details: 'Always prefer npm scripts when working in this repo.',
			tags: ['package-manager'],
			dedupeKey: 'repo:package-manager',
		},
		limit: 3,
		conversationId: 'conv-123',
		includeSuppressedInConversation: true,
	})
	expect(result).toEqual({
		candidate: {
			subject: 'Preferred package manager',
			summary: 'Use npm commands in this repository.',
			details: 'Always prefer npm scripts when working in this repo.',
			category: 'preference',
			tags: ['package-manager'],
			dedupe_key: 'repo:package-manager',
		},
		related_memories: [
			{
				id: 'mem-123',
				category: 'preference',
				status: 'active',
				subject: 'Package manager preference',
				summary: 'Repository workflows use npm.',
				tags: ['package-manager', 'workflow'],
				dedupe_key: 'repo:package-manager',
				score: 0.91,
			},
		],
		recommended_actions: ['upsert', 'delete', 'upsert_and_delete', 'none'],
	})
	expect(result).not.toHaveProperty('guidance')
	expect(result.related_memories[0]).not.toHaveProperty('details')
	expect(result.related_memories[0]).not.toHaveProperty('created_at')
	expect(result.related_memories[0]).not.toHaveProperty('updated_at')
	expect(result.related_memories[0]).not.toHaveProperty('last_accessed_at')
	expect(result.related_memories[0]).not.toHaveProperty('deleted_at')
})
