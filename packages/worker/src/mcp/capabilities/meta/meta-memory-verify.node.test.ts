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

test('meta_memory_verify omits candidate details from the serialized response', async () => {
	mockModule.verifyMemoryCandidate.mockResolvedValueOnce({
		candidate: {
			subject: 'Editor theme preference',
			summary: 'User prefers dark mode in editors.',
			details: 'Long supporting details that should stay out of verify output.',
			category: 'preference',
			tags: ['theme'],
			source_uris: ['https://docs.example.com/preferences/editor-theme'],
			dedupe_key: 'pref:editor-theme',
		},
		relatedMemories: [
			{
				memory: {
					id: 'memory-1',
					category: 'preference',
					status: 'active',
					subject: 'Preferred editor theme',
					summary: 'User prefers a dark theme in editors.',
					details:
						'Existing stored details should also stay out of verify output.',
					tags: ['theme', 'dark-mode'],
					sourceUris: ['https://docs.example.com/preferences/editor-theme'],
					dedupeKey: 'pref:editor-theme',
				},
				score: 0.98,
			},
		],
		suppressedCount: 0,
	})

	const result = await metaMemoryVerifyCapability.handler(
		{
			subject: 'Editor theme preference',
			summary: 'User prefers dark mode in editors.',
			details: 'Candidate details still need to reach the verify service.',
			category: 'preference',
			tags: ['theme'],
			source_uris: ['https://docs.example.com/preferences/editor-theme'],
			dedupe_key: 'pref:editor-theme',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: { userId: 'user-123' },
			}),
		},
	)

	expect(mockModule.verifyMemoryCandidate).toHaveBeenCalledWith(
		expect.objectContaining({
			candidate: expect.objectContaining({
				details: 'Candidate details still need to reach the verify service.',
			}),
		}),
	)
	expect(result).toEqual({
		candidate: {
			subject: 'Editor theme preference',
			summary: 'User prefers dark mode in editors.',
			category: 'preference',
			tags: ['theme'],
			source_uris: ['https://docs.example.com/preferences/editor-theme'],
			dedupe_key: 'pref:editor-theme',
		},
		related_memories: [
			{
				id: 'memory-1',
				category: 'preference',
				status: 'active',
				subject: 'Preferred editor theme',
				summary: 'User prefers a dark theme in editors.',
				tags: ['theme', 'dark-mode'],
				source_uris: ['https://docs.example.com/preferences/editor-theme'],
				dedupe_key: 'pref:editor-theme',
				score: 0.98,
			},
		],
		recommended_actions: ['upsert', 'delete', 'upsert_and_delete', 'none'],
	})
	expect(result.candidate).not.toHaveProperty('details')
	expect(result.related_memories[0]).not.toHaveProperty('details')
})
