import { expect, test, vi } from 'vitest'
import type * as AccessControlModule from '#mcp/capabilities/access-control.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
	resolveCallerFeatureFlags: vi.fn(),
	assertCallerCanAccessCapability: vi.fn(async () => undefined),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: (...args: Array<unknown>) =>
		mockModule.runModuleWithRegistry(...args),
}))

vi.mock(
	'#mcp/capabilities/access-control.ts',
	async (importOriginal: () => Promise<typeof AccessControlModule>) => {
		const actual = await importOriginal()
		return {
			...actual,
			resolveCallerFeatureFlags: (...args: Array<unknown>) =>
				mockModule.resolveCallerFeatureFlags(...args),
			assertCallerCanAccessCapability: (...args: Array<unknown>) =>
				mockModule.assertCallerCanAccessCapability(...args),
		}
	},
)

const { executeCapability } = await import('./execute.ts')

test('execute capability runs modules through the shared execute runtime', async () => {
	vi.clearAllMocks()
	mockModule.resolveCallerFeatureFlags.mockResolvedValue({
		'demo-indicator': false,
		'execute-pre-exec-typecheck': false,
	})
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
		expect.objectContaining({
			storageTools: {
				userId: 'user-1',
				storageId: 'package:agent-turns',
				writable: true,
			},
			runRecordHandle: null,
			runRecord: expect.objectContaining({
				surface: 'execute',
				storageId: 'package:agent-turns',
			}),
			preExecTypecheck: false,
		}),
	)
})

test('execute capability passes the opted-in pre-exec typecheck to the shared runtime', async () => {
	vi.clearAllMocks()
	mockModule.resolveCallerFeatureFlags.mockResolvedValue({
		'demo-indicator': false,
		'execute-pre-exec-typecheck': true,
	})
	mockModule.runModuleWithRegistry.mockResolvedValue({
		result: { marker: 'typecheck-enabled' },
		logs: [],
	})

	await executeCapability.handler(
		{
			code: 'export default async function main() { return { marker: "typecheck-enabled" } }',
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

	expect(mockModule.resolveCallerFeatureFlags).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			user: expect.objectContaining({ userId: 'user-1' }),
		}),
	)
	expect(mockModule.runModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.anything(),
		expect.any(String),
		undefined,
		expect.objectContaining({ preExecTypecheck: true }),
	)
})
