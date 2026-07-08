import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { setMcpServerEnabled } from '#worker/mcp-client/settings-service.ts'
import { resolveMcpServerSetting } from './shared.ts'

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	enabled: z.boolean(),
})

export const mcpServerSetEnabledCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcp_server_set_enabled',
		description:
			'Enable or disable a saved MCP server. Disabled servers keep their stored connection and OAuth state but their tools are hidden from search, execute, and package code until re-enabled.',
		keywords: ['mcp', 'server', 'enable', 'disable', 'toggle', 'client'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			server: z.string().min(1).describe('The saved MCP server id or name.'),
			enabled: z.boolean().describe('Whether the server should be enabled.'),
		}),
		outputSchema,
		async handler(
			args: { server: string; enabled: boolean },
			ctx: CapabilityContext,
		) {
			const user = requireMcpUser(ctx.callerContext)
			const setting = await resolveMcpServerSetting({
				env: ctx.env,
				userId: user.userId,
				server: args.server,
			})
			const updated = await setMcpServerEnabled({
				env: ctx.env,
				userId: user.userId,
				id: setting.id,
				enabled: args.enabled,
			})
			return {
				id: updated.id,
				name: updated.name,
				enabled: updated.enabled,
			}
		},
	},
)
