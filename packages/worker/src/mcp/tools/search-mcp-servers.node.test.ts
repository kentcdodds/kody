import { expect, test } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'

import { formatEntityDetailMarkdown, parseEntityRef } from './search-format.ts'
import {
	buildMcpServerToolIndex,
	findSynthesizedMcpServer,
	listSynthesizedMcpServers,
} from './search-mcp-servers.ts'

function createHomeRegistry() {
	const homeServer = {
		serverId: 'server-home',
		serverName: 'home',
		kodyName: 'home',
	}
	return buildCapabilityRegistry([
		{
			name: 'mcp:home',
			description: 'Use set_pin after unlocking the island router.',
			capabilities: [
				{
					name: 'mcp:home:set_pin',
					domain: 'mcp:home',
					description: 'Set the island router PIN.',
					keywords: ['pin'],
					readOnly: false,
					idempotent: true,
					destructive: false,
					source: 'mcp-server',
					mcpServer: {
						...homeServer,
						mcpToolName: 'island.router.api/set-pin',
						toolName: 'set_pin',
					},
					inputSchema: { type: 'object', properties: {} },
					inputTypeDefinition: 'type SetPinInput = Record<string, never>',
					handler: async () => null,
				},
				{
					name: 'mcp:home:list_lights',
					domain: 'mcp:home',
					description: 'List lights.',
					keywords: ['lights'],
					readOnly: true,
					idempotent: true,
					destructive: false,
					source: 'mcp-server',
					mcpServer: {
						...homeServer,
						mcpToolName: 'list_lights',
						toolName: 'list_lights',
					},
					inputSchema: { type: 'object', properties: {} },
					inputTypeDefinition: 'type ListLightsInput = Record<string, never>',
					handler: async () => null,
				},
			],
		},
	])
}

test('MCP server entities resolve by name or domain and list tools with instructions', () => {
	expect(parseEntityRef('home:mcp-server')).toEqual({
		id: 'home',
		type: 'mcp-server',
	})
	expect(parseEntityRef('mcp:home:mcp-server')).toEqual({
		id: 'mcp:home',
		type: 'mcp-server',
	})

	const registry = createHomeRegistry()
	const servers = listSynthesizedMcpServers(registry)
	expect(servers).toHaveLength(1)
	expect(findSynthesizedMcpServer(servers, 'home')?.kodyName).toBe('home')
	expect(findSynthesizedMcpServer(servers, 'mcp:home')?.domain).toBe('mcp:home')
	expect(findSynthesizedMcpServer(servers, 'missing')).toBeNull()

	const [server] = servers
	expect(server).toMatchObject({
		kodyName: 'home',
		instructions: 'Use set_pin after unlocking the island router.',
	})
	const tools = buildMcpServerToolIndex(server!)
	expect(tools.map((tool) => tool.toolName)).toEqual(['set_pin', 'list_lights'])

	const detail = formatEntityDetailMarkdown({
		type: 'mcp-server',
		id: 'home',
		title: 'home',
		description: server!.description,
		domain: server!.domain,
		kodyName: server!.kodyName,
		serverName: server!.serverName,
		serverId: server!.serverId,
		instructions: server!.instructions,
		usage: server!.usage,
		tools,
		wrappingPackage: null,
	})
	expect(detail.markdown).toContain('# MCP server — `home`')
	expect(detail.markdown).toContain(
		'Use set_pin after unlocking the island router.',
	)
	expect(detail.markdown).toContain('home:mcp-server')
	expect(detail.markdown).toContain('mcp:home:set_pin:capability')
	expect(detail.markdown).toContain('kody.mcp["home"].set_pin(args)')
	expect(detail.structured).toMatchObject({
		type: 'mcp-server',
		entityRef: 'home:mcp-server',
		capabilityCount: 2,
		instructions: 'Use set_pin after unlocking the island router.',
	})
})
