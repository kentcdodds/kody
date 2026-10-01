import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
} from '#mcp/secrets/secret-authority.ts'
import {
	createMcpServerExecuteAccessDeniedMessage,
	McpServerPackageAccessDeniedError,
} from '#worker/mcp-client/package-access.ts'
import { type McpServerSnapshot } from '#worker/mcp-client/types.ts'
import type * as McpClientStatus from '#worker/mcp-client/status.ts'

const mocks = vi.hoisted(() => ({
	callTool: vi.fn(),
	getMcpServerStatus: vi.fn(),
	assertCanUseMcpServer: vi.fn(),
}))

vi.mock('#worker/mcp-client/hub-client.ts', () => ({
	createMcpClientHubClient: () => ({
		callTool: (...args: Array<unknown>) => mocks.callTool(...args),
	}),
}))

vi.mock('#worker/mcp-client/package-access.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/mcp-client/package-access.ts')
	>('#worker/mcp-client/package-access.ts')
	return {
		...actual,
		assertCanUseMcpServer: (...args: Array<unknown>) =>
			mocks.assertCanUseMcpServer(...args),
	}
})

vi.mock('#worker/mcp-client/status.ts', async () => {
	const actual = await vi.importActual<typeof McpClientStatus>(
		'#worker/mcp-client/status.ts',
	)
	return {
		...actual,
		getMcpServerStatus: (...args: Array<unknown>) =>
			mocks.getMcpServerStatus(...args),
	}
})

const { synthesizeMcpServerToolDomain } = await import('./index.ts')

const ref = { serverId: 'server-notion', name: 'notion' }

function createSnapshot(): McpServerSnapshot {
	return {
		serverId: 'server-notion',
		name: 'notion',
		url: 'https://mcp.notion.com/mcp',
		state: 'ready',
		authUrl: null,
		error: null,
		instructions: null,
		tools: [
			{
				name: 'notion_search',
				description: 'Search Notion.',
				inputSchema: { type: 'object', properties: {} },
			},
		],
	}
}

function createExecuteContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-alice',
				email: 'alice@example.com',
				displayName: 'Alice',
			},
			// Ad hoc execute has no packageId — package imports rely on stamp ALS.
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
				storageId: null,
			},
		}),
	}
}

test('locked MCP server honors stamp packageId from package-via-execute and denies bare execute', async () => {
	mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
	mocks.assertCanUseMcpServer.mockResolvedValue(undefined)

	const synthesized = synthesizeMcpServerToolDomain({
		ref,
		snapshot: createSnapshot(),
	})
	const capability = synthesized?.domain.capabilities[0]
	expect(capability).toBeDefined()
	const ctx = createExecuteContext()

	await capability!.handler({}, ctx)
	expect(mocks.assertCanUseMcpServer).toHaveBeenLastCalledWith(
		expect.objectContaining({
			serverId: 'server-notion',
			serverName: 'notion',
			packageId: null,
		}),
	)

	const granted = new Set(['pkg-notion-read'])
	await runWithSecretAuthorityScope(granted, async () => {
		await runWithCurrentSecretAuthority('pkg-notion-read', async () => {
			await capability!.handler({}, ctx)
		})
	})
	expect(mocks.assertCanUseMcpServer).toHaveBeenLastCalledWith(
		expect.objectContaining({
			serverId: 'server-notion',
			packageId: 'pkg-notion-read',
		}),
	)

	const usageUrl = 'https://example.com/account/mcp-servers/server-notion'
	mocks.assertCanUseMcpServer.mockRejectedValueOnce(
		new McpServerPackageAccessDeniedError(
			createMcpServerExecuteAccessDeniedMessage({
				serverName: 'notion',
				usageUrl,
			}),
		),
	)
	const denied = await capability!.handler({}, ctx).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(denied).toBeInstanceOf(McpServerPackageAccessDeniedError)
	expect((denied as Error).message).toBe(
		createMcpServerExecuteAccessDeniedMessage({
			serverName: 'notion',
			usageUrl,
		}),
	)
	expect((denied as Error).message).toContain(usageUrl)
	expect(mocks.callTool).toHaveBeenCalledTimes(2)
})
