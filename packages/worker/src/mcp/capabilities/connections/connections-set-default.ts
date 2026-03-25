import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { setConnectionDefault } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const connectionsSetDefaultCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'connections_set_default',
		description:
			'Mark one stored provider connection as the default for its provider. This is how skills can use selection strategy `default` without needing a hard-coded connection id.',
		keywords: ['connection', 'default', 'provider', 'label'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			connection_id: z.string().min(1),
		}),
		outputSchema: z.object({
			connection_id: z.string(),
			provider_key: z.string(),
			is_default: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return setConnectionDefault({
				env: ctx.env,
				userId: user.userId,
				connectionId: args.connection_id,
			})
		},
	},
)
