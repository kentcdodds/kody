import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteValue } from '#mcp/values/service.ts'
import { buildOpenApiBindingValueName } from '#worker/openapi/binding-shared.ts'

const inputSchema = z
	.object({
		name: z.string().min(1).describe('OpenAPI binding name to delete.'),
	})
	.strict()

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const openapiBindingDeleteCapability = defineDomainCapability(
	capabilityDomainNames.openapi,
	{
		name: 'openapi_binding_delete',
		description:
			'Delete a saved OpenAPI provider binding by name. Bindings are non-secret config; credentials stay in secrets and are not deleted.',
		keywords: [
			'openapi',
			'binding',
			'provider',
			'delete',
			'remove',
			'rest',
			'api',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const deleted = await deleteValue({
				env: ctx.env,
				userId: user.userId,
				name: buildOpenApiBindingValueName(args.name),
				scope: 'user',
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
				},
			})
			return { deleted }
		},
	},
)
