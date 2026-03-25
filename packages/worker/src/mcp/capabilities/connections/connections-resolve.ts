import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { connectionSelectionSchema } from '#mcp/connections/auth-spec.ts'
import { resolveConnection } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

const outputSchema = z.discriminatedUnion('found', [
	z.object({
		found: z.literal(false),
	}),
	z.object({
		found: z.literal(true),
		handle: z.string(),
		connection_id: z.string(),
		provider_key: z.string(),
		display_name: z.string(),
		label: z.string(),
		account_id: z.string().nullable(),
		account_label: z.string().nullable(),
		is_default: z.boolean(),
	}),
])

export const connectionsResolveCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'connections_resolve',
		description:
			'Resolve a stored provider connection for the signed-in user and return an opaque connection handle. By default this throws when no match exists; use allow_missing only when the skill can take a meaningful alternate branch.',
		keywords: [
			'connection',
			'resolve',
			'default',
			'label',
			'id',
			'handle',
			'provider',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			provider: z.string().min(1),
			selection: connectionSelectionSchema.default({ strategy: 'default' }),
			allow_missing: z.boolean().optional(),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return resolveConnection({
				env: ctx.env,
				userId: user.userId,
				provider: args.provider,
				selection: args.selection,
				allowMissing: args.allow_missing,
			})
		},
	},
)
