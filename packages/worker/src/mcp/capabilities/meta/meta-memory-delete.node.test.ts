import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	deleteMemory: vi.fn(),
	getMemory: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', () => ({
	deleteMemory: (...args: Array<unknown>) => mockModule.deleteMemory(...args),
	getMemory: (...args: Array<unknown>) => mockModule.getMemory(...args),
	getMemoryMutationNotFoundMessage: (memoryId: string) =>
		`helpful not-found message for ${memoryId}`,
}))

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
	).rejects.toThrow('helpful not-found message for transcribed-memory-id')
	expect(mockModule.getMemory).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-123',
			memoryId: 'transcribed-memory-id',
		}),
	)
	expect(mockModule.deleteMemory).not.toHaveBeenCalled()
})
