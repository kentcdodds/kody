import type * as MemoryService from '#mcp/memory/service.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getMemoryMutationNotFoundMessage } from '#mcp/memory/service.ts'

const mockModule = vi.hoisted(() => ({
	deleteMemory: vi.fn(),
	getMemory: vi.fn(),
	searchMemoryRecords: vi.fn(),
	verifyMemoryCandidate: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MemoryService>()
	return {
		...actual,
		memorySearchMutationGuidance: 'Use this exact id for memory mutations.',
		deleteMemory: (...args: Array<unknown>) => mockModule.deleteMemory(...args),
		getMemory: (...args: Array<unknown>) => mockModule.getMemory(...args),
		searchMemoryRecords: (...args: Array<unknown>) =>
			mockModule.searchMemoryRecords(...args),
		verifyMemoryCandidate: (...args: Array<unknown>) =>
			mockModule.verifyMemoryCandidate(...args),
	}
})

const { metaMemoryDeleteCapability } = await import('./meta-memory-delete.ts')
const { metaMemorySearchCapability } = await import('./meta-memory-search.ts')
const { metaMemoryVerifyCapability } = await import('./meta-memory-verify.ts')

function createSignedInCapabilityContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
		}),
	}
}

test('memory capabilities support a verify-first mutation workflow', async () => {
	mockModule.searchMemoryRecords.mockReset()
	mockModule.verifyMemoryCandidate.mockReset()
	mockModule.getMemory.mockReset()
	mockModule.deleteMemory.mockReset()

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

	const searchResult = await metaMemorySearchCapability.handler(
		{
			query: 'theme preference',
		},
		createSignedInCapabilityContext(),
	)

	expect(mockModule.searchMemoryRecords).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-123',
			query: 'theme preference',
		}),
	)
	expect(searchResult.matches).toEqual([
		expect.objectContaining({
			id: 'memory-1',
			can_mutate: true,
		}),
	])

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

	const verifyResult = await metaMemoryVerifyCapability.handler(
		{
			subject: 'Editor theme preference',
			summary: 'User prefers dark mode in editors.',
			details: 'Candidate details still need to reach the verify service.',
			category: 'preference',
			tags: ['theme'],
			source_uris: ['https://docs.example.com/preferences/editor-theme'],
			dedupe_key: 'pref:editor-theme',
		},
		createSignedInCapabilityContext(),
	)

	expect(mockModule.verifyMemoryCandidate).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-123',
			candidate: expect.objectContaining({
				details: 'Candidate details still need to reach the verify service.',
			}),
		}),
	)
	expect(verifyResult).toEqual({
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
	expect(verifyResult.candidate).not.toHaveProperty('details')
	expect(verifyResult.related_memories[0]).not.toHaveProperty('details')

	mockModule.getMemory.mockResolvedValueOnce({
		id: 'memory-1',
		category: 'preference',
		status: 'active',
		subject: 'Preferred editor theme',
		summary: 'User prefers a dark theme in editors.',
		details: 'Stored details for the existing memory.',
		tags: ['theme', 'dark-mode'],
		sourceUris: ['https://docs.example.com/preferences/editor-theme'],
		dedupeKey: 'pref:editor-theme',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
		lastAccessedAt: null,
		deletedAt: null,
	})
	mockModule.deleteMemory.mockResolvedValueOnce({
		id: 'memory-1',
		category: 'preference',
		status: 'deleted',
		subject: 'Preferred editor theme',
		summary: 'User prefers a dark theme in editors.',
		details: 'Stored details for the existing memory.',
		tags: ['theme', 'dark-mode'],
		sourceUris: ['https://docs.example.com/preferences/editor-theme'],
		dedupeKey: 'pref:editor-theme',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-03T00:00:00.000Z',
		lastAccessedAt: null,
		deletedAt: '2026-01-03T00:00:00.000Z',
	})

	const deleteResult = await metaMemoryDeleteCapability.handler(
		{
			memory_id: 'memory-1',
			verified_by_agent: true,
		},
		createSignedInCapabilityContext(),
	)

	expect(mockModule.getMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-123',
			memoryId: 'memory-1',
		}),
	)
	expect(mockModule.deleteMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-123',
			memoryId: 'memory-1',
			force: false,
		}),
	)
	expect(deleteResult).toMatchObject({
		ok: true,
		force: false,
		memory: {
			id: 'memory-1',
			status: 'deleted',
		},
	})
})

test('memory deletion rejects ids that were not confirmed during verification', async () => {
	mockModule.searchMemoryRecords.mockReset()
	mockModule.verifyMemoryCandidate.mockReset()
	mockModule.getMemory.mockReset()
	mockModule.deleteMemory.mockReset()
	mockModule.getMemory.mockResolvedValueOnce(null)

	await expect(
		metaMemoryDeleteCapability.handler(
			{
				memory_id: 'transcribed-memory-id',
				verified_by_agent: true,
			},
			createSignedInCapabilityContext(),
		),
	).rejects.toThrow(getMemoryMutationNotFoundMessage('transcribed-memory-id'))

	expect(mockModule.getMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-123',
			memoryId: 'transcribed-memory-id',
		}),
	)
	expect(mockModule.deleteMemory).not.toHaveBeenCalled()
})
