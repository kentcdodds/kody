import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { listValues } from '#mcp/values/service.ts'
import { valueScopeValues } from '#mcp/values/types.ts'
import { valueMetadataSchema } from './shared.ts'

export const valueListCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'value_list',
		description:
			'List readable persisted values for the signed-in user. When scope is omitted, results include every accessible scope in precedence order.',
		keywords: ['value', 'config', 'list', 'metadata', 'non-secret'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			scope: z
				.enum(valueScopeValues)
				.optional()
				.describe(
					'Optional scope filter. When omitted, list all accessible scopes in precedence order.',
				),
		}),
		outputSchema: z.object({
			values: z.array(valueMetadataSchema),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const values = await listValues({
				env: ctx.env,
				userId: user.userId,
				scope: args.scope ?? null,
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
				},
			})
			return {
				values: values.map((value) => ({
					name: value.name,
					scope: value.scope,
					value: value.value,
					description: value.description,
					app_id: value.appId,
					created_at: value.createdAt,
					updated_at: value.updatedAt,
					ttl_ms: value.ttlMs,
				})),
			}
		},
	},
)
