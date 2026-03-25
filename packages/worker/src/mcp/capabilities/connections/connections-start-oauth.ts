import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { startConnectionOAuth } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const connectionsStartOauthCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'connections_start_oauth',
		description:
			'Start an OAuth flow for an existing connection draft and return the authorize URL the user should open.',
		keywords: ['connection', 'oauth', 'authorize', 'provider', 'redirect'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			setup_id: z.string().min(1),
		}),
		outputSchema: z.object({
			setup_id: z.string(),
			authorize_url: z.string(),
			status: z.string(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return startConnectionOAuth({
				env: ctx.env,
				userId: user.userId,
				draftId: args.setup_id,
				baseUrl: ctx.callerContext.baseUrl,
			})
		},
	},
)
