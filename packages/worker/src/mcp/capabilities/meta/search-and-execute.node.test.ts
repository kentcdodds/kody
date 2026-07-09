import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		mockModule.runModuleWithRegistry(...args),
}))

const { executeCapability } = await import('./execute.ts')

test('execute capability runs modules through the shared execute runtime', async () => {
	vi.clearAllMocks()
	mockModule.runModuleWithRegistry.mockResolvedValue({
		result: { marker: 'execute-ok' },
		logs: [{ level: 'info', message: 'ran' }],
	})

	const result = await executeCapability.handler(
		{
			code: 'export default async function main() { return { marker: "execute-ok" } }',
			storageId: 'package:agent-turns',
			writable: true,
			conversationId: 'conv-execute',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'User',
				},
			}),
		},
	)

	expect(result).toMatchObject({
		ok: true,
		conversationId: 'conv-execute',
		storage: { id: 'package:agent-turns' },
		result: { marker: 'execute-ok' },
		logs: [{ level: 'info', message: 'ran' }],
	})
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
				storageId: 'package:agent-turns',
			},
		}),
		expect.stringContaining('execute-ok'),
		undefined,
		{
			storageTools: {
				userId: 'user-1',
				storageId: 'package:agent-turns',
				writable: true,
			},
		},
	)
})
