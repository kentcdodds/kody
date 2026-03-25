import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { performResolvedProviderGraphqlRequest } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

export const providerGraphqlRequestCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'provider_graphql_request',
		description:
			'Perform an authenticated GraphQL request through an opaque provider connection handle. The host owns token use and refresh outside codemode.',
		keywords: ['provider', 'graphql', 'connection handle', 'query', 'mutation'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			connection_handle: z.string().min(1),
			query: z.string().min(1),
			variables: z.record(z.string(), z.unknown()).optional(),
			operationName: z.string().min(1).optional(),
		}),
		outputSchema: z.object({
			status: z.number(),
			data: z.unknown().nullable(),
			errors: z.array(z.unknown()).nullable(),
			extensions: z.unknown().nullable(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return performResolvedProviderGraphqlRequest({
				env: ctx.env,
				userId: user.userId,
				handle: args.connection_handle,
				query: args.query,
				variables: args.variables,
				operationName: args.operationName,
			})
		},
	},
)
