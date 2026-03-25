import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { performResolvedProviderHttpRequest } from '#mcp/connections/connection-service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { providerHttpMethodSchema } from '#mcp/connections/auth-spec.ts'

export const providerHttpRequestCapability = defineDomainCapability(
	capabilityDomainNames.connections,
	{
		name: 'provider_http_request',
		description:
			'Perform a low-level authenticated HTTP request through an opaque provider connection handle. The host decrypts and refreshes credentials outside codemode.',
		keywords: [
			'provider',
			'http',
			'request',
			'rest',
			'connection handle',
			'oauth',
			'api key',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			connection_handle: z.string().min(1),
			request: z.object({
				method: providerHttpMethodSchema,
				path: z.string().min(1),
				query: z.record(z.string(), z.string()).optional(),
				body: z.unknown().optional(),
			}),
		}),
		outputSchema: z.object({
			status: z.number(),
			body: z.unknown().nullable(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return performResolvedProviderHttpRequest({
				env: ctx.env,
				userId: user.userId,
				handle: args.connection_handle,
				request: args.request,
			})
		},
	},
)
