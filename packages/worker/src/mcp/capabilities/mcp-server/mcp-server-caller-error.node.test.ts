import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type McpServerSnapshot } from '#worker/mcp-client/types.ts'

const mocks = vi.hoisted(() => ({
	callTool: vi.fn(),
	getMcpServerStatus: vi.fn(),
}))

vi.mock('#worker/mcp-client/hub-client.ts', () => ({
	createMcpClientHubClient: () => ({
		callTool: (...args: Array<unknown>) => mocks.callTool(...args),
	}),
}))

vi.mock('#worker/mcp-client/status.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/mcp-client/status.ts')
	>('#worker/mcp-client/status.ts')
	return {
		...actual,
		getMcpServerStatus: (...args: Array<unknown>) =>
			mocks.getMcpServerStatus(...args),
	}
})

const { synthesizeMcpServerToolDomain } = await import('./index.ts')

const ref = { serverId: 'server-1', name: 'supermemory' }

function createSnapshot(): McpServerSnapshot {
	return {
		serverId: 'server-1',
		name: 'supermemory',
		url: 'https://mcp.example.com/mcp',
		state: 'ready',
		authUrl: null,
		error: null,
		instructions: null,
		tools: [
			{
				name: 'listMemories',
				description: 'List memories.',
				inputSchema: { type: 'object', properties: {} },
			},
		],
	}
}

function createContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-alice',
				email: 'alice@example.com',
				displayName: 'Alice',
			},
		}),
	}
}

test('mcp-server tool failures throw McpCallerError for downstream ProtocolError', async () => {
	mocks.callTool.mockRejectedValueOnce(
		new Error(
			"ProtocolError: Structured content does not match the tool's output schema",
		),
	)
	mocks.getMcpServerStatus.mockResolvedValueOnce({
		state: 'ready',
		serverId: 'server-1',
		name: 'supermemory',
		ready: true,
		toolCount: 1,
		message: 'connected',
		error: null,
	})

	const synthesized = synthesizeMcpServerToolDomain({
		ref,
		snapshot: createSnapshot(),
	})
	const capability = synthesized?.domain.capabilities[0]
	expect(capability).toBeDefined()

	const error = await capability!.handler({}, createContext()).then(
		() => null,
		(thrown: unknown) => thrown,
	)

	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toContain(
		'MCP server capability "supermemory:listMemories" failed:',
	)
	expect((error as Error).message).toContain('Structured content')
})

test('mcp-server unavailable servers throw McpCallerError', async () => {
	mocks.callTool.mockRejectedValueOnce(new Error('fetch failed'))
	mocks.getMcpServerStatus.mockResolvedValueOnce({
		state: 'disconnected',
		serverId: 'server-1',
		name: 'supermemory',
		ready: false,
		toolCount: 0,
		message: 'The MCP server "supermemory" is not connected.',
		error: null,
	})

	const synthesized = synthesizeMcpServerToolDomain({
		ref,
		snapshot: createSnapshot(),
	})
	const capability = synthesized?.domain.capabilities[0]
	expect(capability).toBeDefined()

	const error = await capability!.handler({}, createContext()).then(
		() => null,
		(thrown: unknown) => thrown,
	)

	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toMatch(/not connected/)
})
