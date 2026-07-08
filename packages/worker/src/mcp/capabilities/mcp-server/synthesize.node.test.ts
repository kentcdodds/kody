import { expect, test } from 'vitest'
import { type McpServerSnapshot } from '#worker/mcp-client/types.ts'
import { synthesizeMcpServerToolDomain } from './index.ts'

const ref = { serverId: 'server-1', name: 'linear' }

function createSnapshot(
	overrides: Partial<McpServerSnapshot> = {},
): McpServerSnapshot {
	return {
		serverId: 'server-1',
		name: 'linear',
		url: 'https://mcp.example.com/mcp',
		state: 'ready',
		authUrl: null,
		error: null,
		instructions: null,
		tools: [
			{
				name: 'create_issue',
				description: 'Create a new issue.',
				inputSchema: {
					type: 'object',
					properties: { title: { type: 'string' } },
					required: ['title'],
				},
			},
			{
				name: 'list_issues',
				description: 'List issues.',
				inputSchema: { type: 'object', properties: {} },
				annotations: { readOnlyHint: true },
			},
		],
		...overrides,
	}
}

test('synthesizes an mcp:<server> domain with a capability per tool', () => {
	const synthesized = synthesizeMcpServerToolDomain({
		ref,
		snapshot: createSnapshot(),
	})

	expect(synthesized).not.toBeNull()
	expect(synthesized?.domain.name).toBe('mcp:linear')
	expect(synthesized?.domain.capabilities.map((c) => c.name)).toEqual([
		'mcp:linear:create_issue',
		'mcp:linear:list_issues',
	])
	expect(synthesized?.bindings['mcp:linear:create_issue']).toEqual({
		capabilityName: 'mcp:linear:create_issue',
		serverId: 'server-1',
		mcpToolName: 'create_issue',
	})

	const createIssue = synthesized?.domain.capabilities.find(
		(capability) => capability.name === 'mcp:linear:create_issue',
	)
	expect(createIssue?.source).toBe('mcp-server')
	expect(createIssue?.readOnly).toBe(false)
	expect(createIssue?.mcpServer).toEqual({
		serverId: 'server-1',
		serverName: 'linear',
		kodyName: 'linear',
		mcpToolName: 'create_issue',
		toolName: 'create_issue',
	})

	const listIssues = synthesized?.domain.capabilities.find(
		(capability) => capability.name === 'mcp:linear:list_issues',
	)
	expect(listIssues?.readOnly).toBe(true)

	expect(synthesizeMcpServerToolDomain({ ref, snapshot: null })).toBeNull()
	expect(
		synthesizeMcpServerToolDomain({
			ref,
			snapshot: createSnapshot({ state: 'authenticating', tools: [] }),
		}),
	).toBeNull()
	expect(
		synthesizeMcpServerToolDomain({
			ref,
			snapshot: createSnapshot({ tools: [] }),
		}),
	).toBeNull()
})
