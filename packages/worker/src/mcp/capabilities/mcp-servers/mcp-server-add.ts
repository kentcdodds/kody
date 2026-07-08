import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { addMcpServer } from '#worker/mcp-client/settings-service.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	state: z.string(),
	toolCount: z.number().int().nonnegative(),
	authUrl: z.string().nullable(),
	error: z.string().nullable(),
	nextStep: z.string(),
})

export const mcpServerAddCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcp_server_add',
		description:
			'Add a remote MCP server for the signed-in user and connect to it. Servers that require OAuth return an authUrl the user must open to authorize Kody; other servers connect immediately. Connected server tools become kody.mcp["server-name"].tool_name(...) capabilities.',
		keywords: [
			'mcp',
			'server',
			'add',
			'connect',
			'client',
			'oauth',
			'remote',
			'tools',
			'integration',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe(
					'Short kebab-case name for the server (lowercase letters, numbers, dashes). Used as kody.mcp["name"] in execute code.',
				),
			url: z
				.string()
				.min(1)
				.describe(
					'The remote MCP server endpoint URL. Must be https (http is only allowed for localhost during development).',
				),
		}),
		outputSchema,
		async handler(args: { name: string; url: string }, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const baseUrl =
				ctx.callerContext.baseUrl || getAppBaseUrl({ env: ctx.env })
			const { setting, connection } = await addMcpServer({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
				url: args.url,
				baseUrl,
			})
			const nextStep =
				connection.state === 'authenticating' && connection.authUrl
					? `The server requires OAuth authorization. Ask the user to open ${connection.authUrl} (also available from ${baseUrl}/account/mcp-servers) to authorize Kody, then check mcp_server_list.`
					: connection.state === 'ready'
						? `Connected with ${connection.toolCount} tool(s). Use search or meta_list_capabilities to discover kody.mcp["${setting.name}"] capabilities.`
						: `Connection state is "${connection.state}". Check mcp_server_list and use mcp_server_reconnect if it does not become ready.`
			return {
				id: setting.id,
				name: setting.name,
				url: setting.url,
				state: connection.state,
				toolCount: connection.toolCount,
				authUrl: connection.authUrl,
				error: connection.error,
				nextStep,
			}
		},
	},
)
