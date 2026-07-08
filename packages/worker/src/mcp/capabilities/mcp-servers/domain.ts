import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { mcpServerAddCapability } from './mcp-server-add.ts'
import { mcpServerListCapability } from './mcp-server-list.ts'
import { mcpServerReconnectCapability } from './mcp-server-reconnect.ts'
import { mcpServerRefreshCapability } from './mcp-server-refresh.ts'
import { mcpServerRemoveCapability } from './mcp-server-remove.ts'
import { mcpServerSetEnabledCapability } from './mcp-server-set-enabled.ts'

export const mcpServersDomain = defineDomain({
	name: capabilityDomainNames.mcpServers,
	description:
		'User-added remote MCP servers that Kody connects to as a client: add (with OAuth support), list with live status, reconnect, refresh tools, enable/disable, and remove. Tools from connected servers appear as synthesized mcp:<server> capability domains callable via kody.mcp["server-name"].tool_name(...).',
	keywords: [
		'mcp',
		'server',
		'client',
		'connect',
		'oauth',
		'remote',
		'tools',
		'integration',
		'model context protocol',
	],
	capabilities: [
		mcpServerAddCapability,
		mcpServerListCapability,
		mcpServerReconnectCapability,
		mcpServerRefreshCapability,
		mcpServerRemoveCapability,
		mcpServerSetEnabledCapability,
	],
})
