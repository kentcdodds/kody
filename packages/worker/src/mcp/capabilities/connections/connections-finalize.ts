import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { finalizeConnectionSetup } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const connectionsFinalizeCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'connections_finalize',
		description:
			'Finalize a connection draft into a durable user-owned provider connection after secure inputs or OAuth credentials have been collected.',
		keywords: ['connection', 'finalize', 'provider', 'oauth', 'token', 'api key'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			setup_id: z.string().min(1),
			make_default: z.boolean().optional(),
		}),
		outputSchema: z.object({
			connection_id: z.string(),
			provider_key: z.string(),
			display_name: z.string(),
			label: z.string(),
			account_id: z.string().nullable(),
			account_label: z.string().nullable(),
			scope_set: z.array(z.string()).nullable(),
			is_default: z.boolean(),
			status: z.string(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return finalizeConnectionSetup({
				env: ctx.env,
				userId: user.userId,
				draftId: args.setup_id,
				makeDefault: args.make_default,
			})
		},
	},
)
