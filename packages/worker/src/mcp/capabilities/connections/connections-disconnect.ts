import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { disconnectConnection } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const connectionsDisconnectCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'connections_disconnect',
		description:
			'Disconnect and delete a stored provider connection for the signed-in user.',
		keywords: ['connection', 'disconnect', 'revoke', 'delete', 'provider'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			connection_id: z.string().min(1),
		}),
		outputSchema: z.object({
			connection_id: z.string(),
			disconnected: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return disconnectConnection({
				env: ctx.env,
				userId: user.userId,
				connectionId: args.connection_id,
			})
		},
	},
)
