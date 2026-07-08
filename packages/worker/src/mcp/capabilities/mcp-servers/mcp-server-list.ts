import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { listMcpServerSettings } from '#worker/mcp-client/settings-service.ts'
import {
	buildMcpServerStatusView,
	loadMcpClientHubSnapshotOrNull,
	mcpServerStatusSchema,
} from './shared.ts'

const outputSchema = z.object({
	servers: z.array(mcpServerStatusSchema),
})

export const mcpServerListCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcp_server_list',
		description:
			"List the signed-in user's saved MCP servers with live connection status, pending OAuth authUrls, and discovered tool names.",
		keywords: [
			'mcp',
			'server',
			'list',
			'status',
			'connection',
			'tools',
			'client',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const [settings, hubSnapshot] = await Promise.all([
				listMcpServerSettings({ env: ctx.env, userId: user.userId }),
				loadMcpClientHubSnapshotOrNull({ env: ctx.env, userId: user.userId }),
			])
			return {
				servers: settings.map((setting) =>
					buildMcpServerStatusView({
						setting,
						snapshot:
							hubSnapshot?.servers.find(
								(server) => server.serverId === setting.id,
							) ?? null,
					}),
				),
			}
		},
	},
)
