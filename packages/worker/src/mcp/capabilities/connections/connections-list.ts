import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { listConnectionsForUser } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

const connectionSummarySchema = z.object({
	connection_id: z.string(),
	provider_key: z.string(),
	display_name: z.string(),
	label: z.string(),
	account_id: z.string().nullable(),
	account_label: z.string().nullable(),
	scope_set: z.array(z.string()).nullable(),
	is_default: z.boolean(),
	status: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
	last_used_at: z.string().nullable(),
	token_expires_at: z.string().nullable(),
})

export const connectionsListCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'connections_list',
		description:
			"List the signed-in user's stored provider connections, including labels, account metadata, scopes, default markers, and timestamps.",
		keywords: [
			'connection',
			'provider',
			'list',
			'account',
			'label',
			'default',
			'scopes',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			connections: z.array(connectionSummarySchema),
		}),
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return {
				connections: await listConnectionsForUser(ctx.env, user.userId),
			}
		},
	},
)
