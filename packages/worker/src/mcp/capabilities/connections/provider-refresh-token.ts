import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { refreshResolvedProviderConnection } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const providerRefreshTokenCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'provider_refresh_token',
		description:
			'Force an authenticated provider connection to refresh or verify its credentials using the host-owned token runtime.',
		keywords: ['provider', 'refresh token', 'oauth', 'connection handle'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			connection_handle: z.string().min(1),
		}),
		outputSchema: z.object({
			connection_id: z.string(),
			status: z.number(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return refreshResolvedProviderConnection({
				env: ctx.env,
				userId: user.userId,
				handle: args.connection_handle,
			})
		},
	},
)
