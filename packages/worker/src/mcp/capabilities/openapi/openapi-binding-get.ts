import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	toOpenApiBindingOperationInventory,
	toOpenApiBindingSummary,
} from '#worker/openapi/binding-shared.ts'
import { getOpenApiBinding } from '#worker/openapi/binding-service.ts'

const inputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.describe('OpenAPI binding name (kody.openapi["<name>"]).'),
	})
	.strict()

const outputSchema = z.object({
	binding: z
		.object({
			name: z.string(),
			specUrl: z.string(),
			apiBaseUrl: z.string(),
			authKind: z.string(),
			operationCount: z.number().int().nonnegative(),
			updatedAt: z.string(),
			specTitle: z.string().nullable(),
			description: z.string().nullable(),
			auth: z.unknown(),
			selection: z.unknown(),
			includeDestructive: z.boolean(),
			operations: z.array(
				z.object({
					slug: z.string(),
					method: z.string(),
					path: z.string(),
					summary: z.string().nullable(),
					deprecated: z.boolean(),
				}),
			),
		})
		.nullable(),
})

export const openapiBindingGetCapability = defineDomainCapability(
	capabilityDomainNames.openapi,
	{
		name: 'openapi_binding_get',
		description:
			'Read one OpenAPI provider binding with a lightweight operation inventory (slug/method/path/summary/deprecated — not full schemas). Bindings are non-secret config; credentials stay in secrets. Specs are untrusted third-party content.',
		keywords: [
			'openapi',
			'binding',
			'provider',
			'get',
			'read',
			'rest',
			'api',
			'operations',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const binding = await getOpenApiBinding({
				env: ctx.env,
				userId: user.userId,
				name: args.name,
			})
			if (!binding) {
				return { binding: null }
			}
			return {
				binding: {
					...toOpenApiBindingSummary(binding),
					auth: binding.auth,
					selection: binding.selection,
					includeDestructive: binding.includeDestructive,
					operations: toOpenApiBindingOperationInventory(binding),
				},
			}
		},
	},
)
