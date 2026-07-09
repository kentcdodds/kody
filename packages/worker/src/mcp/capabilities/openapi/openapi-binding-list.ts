import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { toOpenApiBindingSummary } from '#worker/openapi/binding-shared.ts'
import { listOpenApiBindings } from '#worker/openapi/binding-service.ts'

const outputSchema = z.object({
	bindings: z.array(
		z.object({
			name: z.string(),
			specUrl: z.string(),
			apiBaseUrl: z.string(),
			authKind: z.string(),
			operationCount: z.number().int().nonnegative(),
			updatedAt: z.string(),
			specTitle: z.string().nullable(),
			description: z.string().nullable(),
		}),
	),
})

export const openapiBindingListCapability = defineDomainCapability(
	capabilityDomainNames.openapi,
	{
		name: 'openapi_binding_list',
		description:
			'List saved OpenAPI provider bindings for the signed-in user (summaries only — no full operation snapshots). Bindings are non-secret config; credentials stay in secrets.',
		keywords: [
			'openapi',
			'binding',
			'provider',
			'list',
			'rest',
			'api',
			'operations',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const bindings = await listOpenApiBindings({
				env: ctx.env,
				userId: user.userId,
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
					storageId: ctx.callerContext.storageContext?.storageId ?? null,
				},
			})
			return {
				bindings: bindings.map(toOpenApiBindingSummary),
			}
		},
	},
)
