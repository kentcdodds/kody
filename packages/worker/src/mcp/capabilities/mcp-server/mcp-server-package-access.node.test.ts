import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createToolDispatchers } from '#mcp/executor.ts'
import {
	resolveCallerSecretAuthority,
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
	secretAuthorityArgName,
} from '#mcp/secrets/secret-authority.ts'
import { McpServerPackageAccessDeniedError } from '#worker/mcp-client/package-access.ts'
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
const approvedPackageId = 'pkg-notion-read'

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

	const granted = new Set([approvedPackageId])
	await runWithSecretAuthorityScope(granted, async () => {
		await runWithCurrentSecretAuthority(approvedPackageId, async () => {
			await capability!.handler({}, ctx)
		})
	})
	expect(mocks.assertCanUseMcpServer).toHaveBeenLastCalledWith(
		expect.objectContaining({
			serverId: 'server-notion',
			packageId: approvedPackageId,
		}),
	)

	const usageUrl = 'https://example.com/account/mcp-servers/server-notion'
	mocks.assertCanUseMcpServer.mockRejectedValueOnce(
		new McpServerPackageAccessDeniedError(
			`MCP server "notion" is limited to specific packages and cannot be used from execute. Approve a package at ${usageUrl}, or switch the server back to any context.`,
		),
	)
	const denied = await capability!.handler({}, ctx).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(denied).toBeInstanceOf(McpServerPackageAccessDeniedError)
	expect((denied as Error).message).toContain(usageUrl)
	expect(mocks.callTool).toHaveBeenCalledTimes(2)
})

test('dispatcher restores grant set after ALS gap so secret-free package stamp reaches locked MCP', async () => {
	// Production gap: sandbox → ToolDispatcher RPC drops host ALS. #2792's
	// host-only ALS injection test stayed green while package-via-execute failed.
	mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
	mocks.assertCanUseMcpServer.mockResolvedValue(undefined)

	const synthesized = synthesizeMcpServerToolDomain({
		ref,
		snapshot: createSnapshot(),
	})
	const capability = synthesized?.domain.capabilities[0]
	expect(capability).toBeDefined()
	const ctx = createExecuteContext()

	const parseCall = async (result: Promise<string | undefined>) =>
		JSON.parse((await result) ?? '{}') as {
			result?: unknown
			error?: string
		}

	const granted = new Set([approvedPackageId])
	// Create dispatchers with grants captured from props — no ambient ALS.
	// Use a simple tool name so sanitizeToolName is a no-op (MCP capability
	// names like mcp:notion:… sanitize; this test targets grant restore).
	const dispatchers = createToolDispatchers(
		[
			{
				name: 'kody',
				fns: {
					invokeLockedMcp: async (args: unknown) =>
						capability!.handler((args ?? {}) as Record<string, unknown>, ctx),
				},
			},
		],
		{ active: true },
		undefined,
		undefined,
		granted,
	)
	const kodyDispatcher = dispatchers.kody
	if (!kodyDispatcher) throw new Error('Expected kody dispatcher')

	// Call outside any secret-authority ALS (simulates Workers RPC boundary).
	const stamped = await parseCall(
		kodyDispatcher.call(
			'invokeLockedMcp',
			JSON.stringify({
				query: 'docs',
				[secretAuthorityArgName]: approvedPackageId,
			}),
		),
	)
	expect(stamped.error).toBeUndefined()
	expect(mocks.assertCanUseMcpServer).toHaveBeenLastCalledWith(
		expect.objectContaining({
			serverId: 'server-notion',
			packageId: approvedPackageId,
		}),
	)

	// Bare execute: no stamp → packageId null (lock deny at assertCanUseMcpServer).
	mocks.assertCanUseMcpServer.mockClear()
	mocks.assertCanUseMcpServer.mockResolvedValue(undefined)
	await parseCall(kodyDispatcher.call('invokeLockedMcp', JSON.stringify({})))
	expect(mocks.assertCanUseMcpServer).toHaveBeenLastCalledWith(
		expect.objectContaining({
			packageId: null,
		}),
	)

	// Forged stamp outside the grant set fails closed (null authority).
	mocks.assertCanUseMcpServer.mockClear()
	await parseCall(
		kodyDispatcher.call(
			'invokeLockedMcp',
			JSON.stringify({
				[secretAuthorityArgName]: 'pkg-forged',
			}),
		),
	)
	expect(mocks.assertCanUseMcpServer).toHaveBeenLastCalledWith(
		expect.objectContaining({
			packageId: null,
		}),
	)

	// Without captured grants, peeled stamp alone reinstalls an empty set and
	// fails closed — the pre-fix production failure mode.
	const ungatedDispatchers = createToolDispatchers(
		[
			{
				name: 'kody',
				fns: {
					probe: async () =>
						resolveCallerSecretAuthority({
							storageContext: ctx.callerContext.storageContext,
						}).authorityPackageId,
				},
			},
		],
		{ active: true },
	)
	const ungated = await parseCall(
		ungatedDispatchers.kody!.call(
			'probe',
			JSON.stringify({
				[secretAuthorityArgName]: approvedPackageId,
			}),
		),
	)
	expect(ungated.result).toBeNull()
})
