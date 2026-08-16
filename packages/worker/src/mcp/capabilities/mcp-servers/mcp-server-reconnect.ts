import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import { enrichMcpOAuthProviderError } from '#worker/mcp-client/oauth-provider-error.ts'
import { resolveMcpServerOAuthClientUrls } from '#worker/mcp-client/settings-service.ts'
import { resolveMcpServerSetting } from './shared.ts'

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	state: z.string(),
	toolCount: z.number().int().nonnegative(),
	authUrl: z.string().nullable(),
	error: z.string().nullable(),
	oauthClientOrigin: z.string(),
	oauthCallbackUrl: z.string(),
})

export const mcpServerReconnectCapability = defineDomainCapability(
	capabilityDomainNames.mcpServers,
	{
		name: 'mcp_server_reconnect',
		description:
			'Retry connecting to a saved MCP server that is failed or disconnected. Returns the resulting connection state; an authUrl means the user must re-authorize via OAuth.',
		keywords: ['mcp', 'server', 'reconnect', 'retry', 'connection', 'client'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			server: z.string().min(1).describe('The saved MCP server id or name.'),
		}),
		outputSchema,
		async handler(args: { server: string }, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const setting = await resolveMcpServerSetting({
				env: ctx.env,
				userId: user.userId,
				server: args.server,
			})
			const oauth = resolveMcpServerOAuthClientUrls({
				env: ctx.env,
				requestUrl: ctx.callerContext.baseUrl,
			})
			const hub = createMcpClientHubClient({
				env: ctx.env,
				userId: user.userId,
			})
			const result = await hub.reconnectServer({
				serverId: setting.id,
				callbackUrl: oauth.callbackUrl,
			})
			return {
				id: setting.id,
				name: setting.name,
				state: result.state,
				toolCount: result.toolCount,
				authUrl: result.authUrl,
				error: result.error
					? enrichMcpOAuthProviderError(result.error, oauth)
					: null,
				oauthClientOrigin: oauth.clientOrigin,
				oauthCallbackUrl: oauth.callbackUrl,
			}
		},
	},
)
