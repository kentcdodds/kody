import type * as MemoryService from '#mcp/memory/service.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getMemoryMutationNotFoundMessage } from '#mcp/memory/service.ts'

const mockModule = vi.hoisted(() => ({
	deleteMemory: vi.fn(),
	getMemory: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MemoryService>()
	return {
		...actual,
		deleteMemory: (...args: Array<unknown>) => mockModule.deleteMemory(...args),
		getMemory: (...args: Array<unknown>) => mockModule.getMemory(...args),
	}
})

const { metaMemoryDeleteCapability } = await import('./meta-memory-delete.ts')

test('meta_memory_delete uses the mutation not-found guidance for rejected ids', async () => {
	mockModule.getMemory.mockResolvedValueOnce(null)

	await expect(
		metaMemoryDeleteCapability.handler(
			{
				memory_id: 'transcribed-memory-id',
				verified_by_agent: true,
			},
			{
				env: {} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					user: { userId: 'user-123' },
				}),
			},
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
